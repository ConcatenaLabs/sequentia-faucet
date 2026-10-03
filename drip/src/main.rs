//! `faucet-drip`: pays from the faucet's reserve, a `sequentia/faucet-drip`
//! covenant output, one drip at a time.
//!
//! ```text
//! faucet-drip key      --mnemonic-file F | --new [--mnemonic-file F]
//! faucet-drip instance --asset A --faucet-key K --treasury-key K --interval N --fee-cap N
//!                      --tiers F1,M1,F2,M2,F3,M3,M4 --recovery-delay N (--genesis G | NODE)
//! faucet-drip address  --instance I
//! faucet-drip status   --instance I NODE
//! faucet-drip drip     --instance I --mnemonic-file F --to ADDRESS [--amount N]
//!                      [--fee-rate R] [--dry-run] NODE
//! faucet-drip recover  --instance I --mnemonic-file F --to ADDRESS [--fee-rate R]
//!                      [--dry-run] NODE
//!
//! NODE: --cli PATH [--datadir DIR] [--cli-arg ARG]...
//! ```
//!
//! Every command reads the template from `--template DIR`, by default the
//! `faucet_drip` template of the `sequentia-contracts` revision this tool is
//! built with, and refuses any template but the one it pins. It prints one JSON
//! object on success; on failure it prints the reason on stderr and exits 1, or
//! 3 when the reserve's interval has not passed yet.
//!
//! The drip is built with the framework (`smplx-sdk`): the program is compiled,
//! placed in its contract tree and checked against the descriptor's derivation;
//! the faucet's contract key signs it; the program is run and pruned against
//! the final transaction, so a drip the covenant would refuse is never
//! broadcast; and its cost is checked against the budget its witness earns.
//! Its weight is measured on a draft that differs from the final transaction
//! only in two amounts, so the fee is exact. The node is reached through
//! `sequentia-cli`, configured as the faucet configures it.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::str::FromStr;

use serde_json::{json, Value};

use sequentia_contracts::descriptor::{Descriptor, Model, Node as TreeNode};
use sequentia_contracts::simplicityhl::elements::encode::{deserialize, serialize_hex};
use sequentia_contracts::simplicityhl::elements::{
    confidential, AssetId, BlockHash, OutPoint, Script, Sequence, Transaction, TxOut, Txid,
};
use sequentia_contracts::simplicityhl::str::WitnessName;
use sequentia_contracts::simplicityhl::{Arguments, Value as HlValue, WitnessValues};

use smplx_sdk::program::{ArgumentsTrait, BudgetRule, Program, ProgramTrait, SpendBudget};
use smplx_sdk::provider::SimplicityNetwork;
use smplx_sdk::signer::{FeeAsset, Signer, SignerTrait};
use smplx_sdk::taptree::{ContractTree, TapTree};
use smplx_sdk::transaction::{
    FinalTransaction, PartialInput, PartialOutput, RequiredSignature, SigMessage, UTXO,
};

/// The template this tool drips from, by its hash: `sequentia/faucet-drip`, version 1.
const TEMPLATE_HASH: &str = "12986f202fbfb850f7699c5d5188f261f276de6c7038142f0a28bbb672b5af34";
/// The leaf names the template gives its drip program and its recovery script.
const DRIP_LEAF: &str = "drip";
const RECOVER_LEAF: &str = "recover";
/// BIP68's type flag: a relative lock in units of 512 seconds.
const TIME_FLAG: u32 = 1 << 22;
/// The dust relay fee a node applies unless told otherwise, in reference units per 1,000 vbytes.
const DUST_RELAY_FEE: u64 = 100;
/// The exit code for a drip asked for before the reserve's interval has passed.
const EXIT_TOO_EARLY: u8 = 3;

/// An error, and whether it is the interval's.
struct Fail {
    message: String,
    too_early: bool,
}

impl<E: std::fmt::Display> From<E> for Fail {
    fn from(e: E) -> Self {
        Fail {
            message: e.to_string(),
            too_early: false,
        }
    }
}

fn fail<T>(message: impl Into<String>) -> Result<T, Fail> {
    Err(Fail {
        message: message.into(),
        too_early: false,
    })
}

type Res<T> = Result<T, Fail>;

// ---------------------------------------------------------------------------
// Arguments

struct Args {
    command: String,
    values: BTreeMap<String, String>,
    cli_args: Vec<String>,
    flags: Vec<String>,
}

impl Args {
    fn parse() -> Res<Self> {
        let mut it = std::env::args().skip(1);
        let command = it.next().ok_or_else(|| Fail::from(USAGE))?;
        let (mut values, mut cli_args, mut flags) = (BTreeMap::new(), Vec::new(), Vec::new());
        while let Some(a) = it.next() {
            match a.as_str() {
                "--dry-run" | "--new" => flags.push(a),
                "--cli-arg" => cli_args.push(
                    it.next()
                        .ok_or_else(|| Fail::from("--cli-arg wants a value"))?,
                ),
                s if s.starts_with("--") => {
                    let v = it
                        .next()
                        .ok_or_else(|| Fail::from(format!("{s} wants a value")))?;
                    if values.insert(s[2..].to_string(), v).is_some() {
                        return fail(format!("{s} is given twice"));
                    }
                }
                _ => return fail(format!("unexpected argument {a}\n{USAGE}")),
            }
        }
        Ok(Args {
            command,
            values,
            cli_args,
            flags,
        })
    }

    fn get(&self, k: &str) -> Res<&str> {
        self.values
            .get(k)
            .map(String::as_str)
            .ok_or_else(|| Fail::from(format!("--{k} is required")))
    }

    fn opt(&self, k: &str) -> Option<&str> {
        self.values.get(k).map(String::as_str)
    }

    fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|f| f == k)
    }

    /// Refuses any option the command does not take.
    fn only(&self, allowed: &[&str]) -> Res<()> {
        for k in self.values.keys() {
            if !allowed.contains(&k.as_str()) {
                return fail(format!("{} does not take --{k}", self.command));
            }
        }
        Ok(())
    }
}

const USAGE: &str = "usage: faucet-drip (key | instance | address | status | drip | recover) [options]; see the README";

// ---------------------------------------------------------------------------
// The node, through sequentia-cli

struct NodeCli {
    cli: String,
    args: Vec<String>,
}

impl NodeCli {
    fn from(a: &Args) -> Res<Self> {
        let mut args = Vec::new();
        if let Some(d) = a.opt("datadir") {
            args.push(format!("-datadir={d}"));
        }
        args.extend(a.cli_args.iter().cloned());
        Ok(NodeCli {
            cli: a.get("cli")?.to_string(),
            args,
        })
    }

    /// One call; its answer as JSON, or as a string when it is not JSON.
    fn call(&self, method: &str, params: &[String]) -> Res<Value> {
        let out = Command::new(&self.cli)
            .args(&self.args)
            .arg(method)
            .args(params)
            .output()
            .map_err(|e| Fail::from(format!("{}: {e}", self.cli)))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return fail(format!(
                "{method}: {}",
                err.trim().lines().last().unwrap_or("failed")
            ));
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    fn string(&self, method: &str, params: &[String]) -> Res<String> {
        match self.call(method, params)? {
            Value::String(s) => Ok(s),
            v => Ok(v.to_string()),
        }
    }

    /// The Sequentia network the node runs, read from the node: a node with no
    /// fee exchange-rate table is not a Sequentia node.
    fn network(&self) -> Res<SimplicityNetwork> {
        self.call("getfeeexchangerates", &[])
            .map_err(|e| Fail::from(format!("not a Sequentia node: {}", e.message)))?;
        let genesis = BlockHash::from_str(&self.string("getblockhash", &["0".into()])?)?;
        if genesis == SimplicityNetwork::SequentiaTestnet.genesis_block_hash() {
            return Ok(SimplicityNetwork::SequentiaTestnet);
        }
        let info = self.call("getsidechaininfo", &[])?;
        let policy = info["pegged_asset"]
            .as_str()
            .ok_or_else(|| Fail::from("getsidechaininfo: no pegged_asset"))?;
        Ok(SimplicityNetwork::SequentiaRegtest {
            policy_asset: AssetId::from_str(policy)?,
            genesis_hash: genesis,
        })
    }

    fn mediantime_at(&self, height: u64) -> Res<u64> {
        let hash = self.string("getblockhash", &[height.to_string()])?;
        self.call("getblockheader", &[hash])?["mediantime"]
            .as_u64()
            .ok_or_else(|| Fail::from("getblockheader: no mediantime"))
    }

    fn tip_mediantime(&self) -> Res<u64> {
        self.call("getblockchaininfo", &[])?["mediantime"]
            .as_u64()
            .ok_or_else(|| Fail::from("getblockchaininfo: no mediantime"))
    }

    /// The node's exchange rate for fees in `asset`: atoms per 10^8 reference units.
    fn exchange_rate(&self, asset: AssetId) -> Res<u64> {
        let rates = self.call("getfeeexchangerates", &[])?;
        let id = asset.to_string();
        if let Some(r) = rates.get(&id).and_then(Value::as_u64) {
            return Ok(r);
        }
        let labels = self.call("dumpassetlabels", &[])?;
        let label = labels.as_object().and_then(|m| {
            m.iter()
                .find(|(_, v)| v.as_str() == Some(id.as_str()))
                .map(|(k, _)| k.clone())
        });
        match label.and_then(|l| rates.get(&l).and_then(Value::as_u64)) {
            Some(r) if r > 0 => Ok(r),
            _ => fail(format!(
                "the node accepts no fee in {id}, so a drip cannot pay its fee in it"
            )),
        }
    }

    /// The node's fee rate floor and estimate, in reference units per 1,000 vbytes.
    fn fee_rate(&self) -> Res<u64> {
        let coins = |v: &Value| v.as_f64().unwrap_or(0.0);
        let relay = coins(&self.call("getnetworkinfo", &[])?["relayfee"]);
        let mempool = coins(&self.call("getmempoolinfo", &[])?["mempoolminfee"]);
        let estimate = self
            .call("estimatesmartfee", &["2".into()])
            .ok()
            .map(|v| coins(&v["feerate"]))
            .unwrap_or(0.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let per_kvb = (relay.max(mempool).max(estimate) * 100_000_000.0).ceil() as u64;
        Ok(per_kvb.max(1))
    }
}

// ---------------------------------------------------------------------------
// The template and the instance

struct Template {
    descriptor: Descriptor,
    model: Model,
    dir: PathBuf,
}

fn template(a: &Args) -> Res<Template> {
    let dir = match a.opt("template") {
        Some(d) => PathBuf::from(d),
        None => sequentia_contracts::helpers_dir().join("../templates/faucet_drip"),
    };
    let descriptor = Descriptor::load(&dir.join("descriptor.json"))?;
    if descriptor.template_hash != TEMPLATE_HASH {
        return fail(format!(
            "{}: template {} is not the faucet drip template this tool drips from, {TEMPLATE_HASH}",
            dir.display(),
            descriptor.template_hash
        ));
    }
    // Compiles each source with the pinned compiler and checks its root,
    // lints, witness and cost bound against the descriptor.
    descriptor.validate(&dir)?;
    let model = descriptor.model()?;
    Ok(Template {
        descriptor,
        model,
        dir,
    })
}

struct Instance {
    params: BTreeMap<String, String>,
    slots: BTreeMap<String, String>,
    genesis: Option<String>,
}

fn strings(v: &Value, at: &str) -> Res<BTreeMap<String, String>> {
    let obj = v
        .as_object()
        .ok_or_else(|| Fail::from(format!("{at} is not an object")))?;
    obj.iter()
        .map(|(k, v)| {
            v.as_str()
                .map(|s| (k.clone(), s.to_string()))
                .ok_or_else(|| Fail::from(format!("{at}.{k} is not a string")))
        })
        .collect()
}

fn instance(a: &Args) -> Res<Instance> {
    let path = a.get("instance")?;
    let text = std::fs::read_to_string(path).map_err(|e| Fail::from(format!("{path}: {e}")))?;
    let v = sequentia_contracts::descriptor::parse_json(&text)?;
    let obj = v
        .as_object()
        .ok_or_else(|| Fail::from("an instance is a JSON object"))?;
    for k in obj.keys() {
        if !["instance", "template_hash", "params", "slots", "genesis"].contains(&k.as_str()) {
            return fail(format!("{path}: unknown field {k}"));
        }
    }
    if v["instance"] != json!(2) {
        return fail(format!("{path}: instance is not 2"));
    }
    if v["template_hash"] != json!(TEMPLATE_HASH) {
        return fail(format!(
            "{path}: the instance is of template {}, not {TEMPLATE_HASH}",
            v["template_hash"]
        ));
    }
    let genesis = match &v["genesis"] {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        _ => return fail(format!("{path}: genesis is a hash or null")),
    };
    Ok(Instance {
        params: strings(&v["params"], "params")?,
        slots: strings(v.get("slots").unwrap_or(&json!({})), "slots")?,
        genesis,
    })
}

/// The instance's asset. The parameter holds it in internal byte order, as the
/// program reads it, which is the order `AssetId` keeps; its display hex, as
/// an RPC prints it, is the reverse.
fn instance_asset(inst: &Instance) -> Res<AssetId> {
    Ok(AssetId::from_slice(&unhex(&inst.params["ASSET"])?)?)
}

fn param_u64(inst: &Instance, name: &str) -> Res<u64> {
    let h = inst
        .params
        .get(name)
        .ok_or_else(|| Fail::from(format!("no parameter {name}")))?;
    Ok(u64::from_str_radix(h, 16)?)
}

/// The tier table, `(floor, max)` from the top, the last floor zero.
fn tiers(inst: &Instance) -> Res<[(u64, u64); 4]> {
    Ok([
        (
            param_u64(inst, "TIER1_FLOOR")?,
            param_u64(inst, "TIER1_MAX")?,
        ),
        (
            param_u64(inst, "TIER2_FLOOR")?,
            param_u64(inst, "TIER2_MAX")?,
        ),
        (
            param_u64(inst, "TIER3_FLOOR")?,
            param_u64(inst, "TIER3_MAX")?,
        ),
        (0, param_u64(inst, "TIER4_MAX")?),
    ])
}

/// The most a drip may pay from `reserve`: as the program computes it.
fn tier_for(inst: &Instance, reserve: u64) -> Res<u64> {
    Ok(tiers(inst)?
        .into_iter()
        .find(|(floor, _)| reserve >= *floor)
        .map_or(0, |(_, max)| max))
}

#[derive(Clone)]
struct NoArguments;

impl ArgumentsTrait for NoArguments {
    fn build_arguments(&self) -> Arguments {
        Arguments::default()
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The covenant's contract tree, built with the framework from the
/// descriptor's tree and the instance's values, and checked against the
/// descriptor's own derivation: the same script and the same control blocks.
fn contract(
    t: &Template,
    inst: &Instance,
) -> Res<(ContractTree, sequentia_contracts::descriptor::TreeDerived)> {
    let derived = t.model.derive(&inst.params, &inst.slots)?;
    let mut values = inst.params.clone();
    values.extend(inst.slots.clone());
    fn walk(t: &Template, n: &TreeNode, values: &BTreeMap<String, String>) -> Res<TapTree> {
        Ok(match n {
            TreeNode::Branch(a, b) => TapTree::branch(walk(t, a, values)?, walk(t, b, values)?),
            TreeNode::Simplicity { name, program } => {
                let raw = std::fs::read_to_string(t.dir.join(&program.source))?;
                let text = sequentia_contracts::expand(&raw)?;
                let p = Program::new(text, &NoArguments).with_debug_symbols(false);
                let cmr = hex(&p.try_cmr()?);
                if cmr != program.cmr {
                    return fail(format!(
                        "leaf {name}: the framework compiles it to {cmr}, the descriptor says {}",
                        program.cmr
                    ));
                }
                TapTree::simplicity(name.clone(), p)
            }
            TreeNode::Tapscript { name, items } => {
                TapTree::tapscript(name.clone(), Script::from(t.model.script(items, values)?))
            }
            TreeNode::Data { values: names, .. } => TapTree::data(&t.model.data(names, values)?),
        })
    }
    let key = sequentia_contracts::simplicityhl::elements::secp256k1_zkp::XOnlyPublicKey::from_str(
        &t.model.internal_key,
    )?;
    let tree = ContractTree::new(key, walk(t, &t.model.tree, &values)?)?;
    if hex(tree.script_pubkey().as_bytes()) != derived.script_pubkey {
        return fail("the framework's tree and the descriptor derive different scripts");
    }
    for (name, leaf) in &derived.leaves {
        if let Some(cb) = &leaf.control_block {
            if &hex(&tree.control_block(name)?.serialize()) != cb {
                return fail(format!(
                    "leaf {name}: the framework's control block is not the descriptor's"
                ));
            }
        }
    }
    Ok((tree, derived))
}

fn check_chain(inst: &Instance, network: &SimplicityNetwork) -> Res<()> {
    let genesis = network.genesis_block_hash().to_string();
    match &inst.genesis {
        Some(g) if g == &genesis => Ok(()),
        Some(g) => fail(format!(
            "the instance is for the chain with genesis {g}; the node runs {genesis}"
        )),
        None => fail("the instance names no chain (genesis null); name the chain it is used on"),
    }
}

// ---------------------------------------------------------------------------
// The reserve

struct Reserve {
    outpoint: OutPoint,
    txout: TxOut,
    asset: AssetId,
    amount: u64,
    height: u64,
}

/// Every explicit coin of the instance's asset at the covenant's script,
/// read from the node's UTXO set. A coin of another asset, or a
/// confidential one, cannot be dripped, and is not listed.
fn reserves(node: &NodeCli, script: &Script, asset: AssetId) -> Res<Vec<Reserve>> {
    let scan = node.call(
        "scantxoutset",
        &[
            "start".into(),
            json!([format!("raw({})", hex(script.as_bytes()))]).to_string(),
        ],
    )?;
    let mut out = Vec::new();
    for u in scan["unspents"]
        .as_array()
        .ok_or_else(|| Fail::from("scantxoutset: no unspents"))?
    {
        let txid = Txid::from_str(u["txid"].as_str().unwrap_or_default())?;
        let vout = u32::try_from(u["vout"].as_u64().unwrap_or(u64::MAX))?;
        let height = u["height"]
            .as_u64()
            .ok_or_else(|| Fail::from("scantxoutset: no height"))?;
        // The exact output, from its block: no transaction index is needed.
        let block = node.string("getblockhash", &[height.to_string()])?;
        let raw = node.string(
            "getrawtransaction",
            &[txid.to_string(), "false".into(), block],
        )?;
        let tx: Transaction = deserialize(&unhex(&raw)?)?;
        let txout = tx
            .output
            .get(vout as usize)
            .ok_or_else(|| Fail::from("vout out of range"))?
            .clone();
        if txout.script_pubkey != *script {
            return fail("scantxoutset returned another script");
        }
        if let (confidential::Asset::Explicit(a), confidential::Value::Explicit(v)) =
            (txout.asset, txout.value)
        {
            if a == asset {
                out.push(Reserve {
                    outpoint: OutPoint::new(txid, vout),
                    txout,
                    asset: a,
                    amount: v,
                    height,
                });
            }
        }
    }
    Ok(out)
}

fn unhex(s: &str) -> Res<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return fail("odd hex");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Fail::from))
        .collect()
}

/// Seconds the reserve must still wait before a drip can confirm in the next block.
fn wait_left(node: &NodeCli, r: &Reserve, interval: u16) -> Res<u64> {
    // BIP68 counts from the median time past of the block before the coin's.
    let start = node.mediantime_at(r.height.saturating_sub(1))?;
    let due = start + u64::from(interval) * 512;
    Ok(due.saturating_sub(node.tip_mediantime()?))
}

// ---------------------------------------------------------------------------
// The drip

/// The witness values of the drip program: the parameters it checks against
/// its data leaf, and the faucet key's signature.
fn witness(program: &Program, inst: &Instance, sig: Option<&[u8; 64]>) -> Res<WitnessValues> {
    let types = program.get_witness_types()?;
    let mut map = std::collections::HashMap::new();
    for (name, ty) in types.iter() {
        let n: &str = name.as_ref();
        let literal = if n == "SIG" {
            format!("0x{}", hex(sig.unwrap_or(&[0; 64])))
        } else {
            let h = inst
                .params
                .get(n)
                .ok_or_else(|| Fail::from(format!("no parameter {n}")))?;
            match ty.to_string().as_str() {
                "u16" | "u32" | "u64" => u64::from_str_radix(h, 16)?.to_string(),
                _ => format!("0x{h}"),
            }
        };
        let value = HlValue::parse_from_str(&literal, ty)
            .map_err(|e| Fail::from(format!("witness {n}: {e}")))?;
        map.insert(WitnessName::from_str_unchecked(n), value);
    }
    Ok(WitnessValues::from(map))
}

struct Built {
    tx: Transaction,
    budget: SpendBudget,
    stack: Vec<Vec<u8>>,
}

/// A drip of `drip` atoms from `r` to `to`, paying `fee`, signed and finalized.
/// Running the program prunes it against this transaction, so a drip the
/// covenant refuses fails here.
#[allow(clippy::too_many_arguments)]
fn build(
    tree: &ContractTree,
    inst: &Instance,
    signer: &Signer,
    network: &SimplicityNetwork,
    r: &Reserve,
    drip: u64,
    fee: u64,
    to: &Script,
) -> Res<Built> {
    let interval = u16::from_str_radix(&inst.params["INTERVAL"], 16)?;
    let rest = r
        .amount
        .checked_sub(drip)
        .and_then(|x| x.checked_sub(fee))
        .ok_or_else(|| Fail::from("the reserve holds less than the drip and its fee"))?;
    let mut ft = FinalTransaction::new();
    let utxo = UTXO {
        outpoint: r.outpoint,
        txout: r.txout.clone(),
        secrets: None,
    };
    ft.add_input(
        PartialInput::new(utxo)
            .with_sequence(Sequence::from_consensus(TIME_FLAG | u32::from(interval))),
        RequiredSignature::None,
    );
    ft.add_output(PartialOutput::new(tree.script_pubkey(), rest, r.asset));
    ft.add_output(PartialOutput::new(to.clone(), drip, r.asset));
    ft.add_output(PartialOutput::new(Script::new(), fee, r.asset));
    let (mut pst, _) = ft.extract_pst();
    let program = tree.program(DRIP_LEAF)?;
    let sig = signer.sign_program(&pst, &program, 0, network, None, &SigMessage::Sighash)?;
    let wv = witness(&program, inst, Some(&sig.serialize()))?;
    let spend = program
        .finalize_spend(&pst, &wv, 0, network)
        .map_err(|e| Fail::from(format!("the covenant refuses this drip: {e}")))?;
    let rule: BudgetRule = network.simplicity_budget();
    if !rule.covers(spend.cost, &spend.stack) {
        return fail("the drip's witness does not earn its cost bound; this tool does not pad");
    }
    let budget = rule.report(spend.cost, &spend.stack);
    pst.inputs_mut()[0].final_script_witness = Some(spend.stack.clone());
    Ok(Built {
        tx: pst.extract_tx()?,
        budget,
        stack: spend.stack,
    })
}

fn address_script(network: &SimplicityNetwork, address: &str) -> Res<Script> {
    let a = sequentia_contracts::simplicityhl::elements::Address::parse_with_params(
        address,
        network.address_params(),
    )
    .map_err(|e| Fail::from(format!("{address}: not an address on this chain: {e}")))?;
    if a.is_blinded() {
        return fail(format!(
            "{address} is a confidential address; the covenant pays only explicit outputs, so give the recipient's transparent address"
        ));
    }
    Ok(a.script_pubkey())
}

fn mnemonic(a: &Args) -> Res<String> {
    let path = a.get("mnemonic-file")?;
    let text = std::fs::read_to_string(path).map_err(|e| Fail::from(format!("{path}: {e}")))?;
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn cmd_drip(a: &Args) -> Res<Value> {
    a.only(&[
        "instance",
        "template",
        "mnemonic-file",
        "to",
        "amount",
        "fee-rate",
        "cli",
        "datadir",
    ])?;
    let t = template(a)?;
    let inst = instance(a)?;
    let node = NodeCli::from(a)?;
    let network = node.network()?;
    check_chain(&inst, &network)?;
    let (tree, _) = contract(&t, &inst)?;
    let signer = Signer::from_mnemonic(&mnemonic(a)?, network);
    if hex(&signer.get_schnorr_public_key().serialize()) != inst.params["FAUCET_KEY"] {
        return fail("this mnemonic's contract key is not the instance's faucet key");
    }
    let asset = instance_asset(&inst)?;
    let to = address_script(&network, a.get("to")?)?;
    let interval = u16::from_str_radix(&inst.params["INTERVAL"], 16)?;
    let cap = param_u64(&inst, "FEE_CAP")?;

    // The reserve: of the coins whose interval has passed, the largest.
    let mut ready = Vec::new();
    let mut soonest: Option<u64> = None;
    for r in reserves(&node, &tree.script_pubkey(), asset)? {
        let left = wait_left(&node, &r, interval)?;
        if left == 0 {
            ready.push(r);
        } else {
            soonest = Some(soonest.map_or(left, |s| s.min(left)));
        }
    }
    let Some(r) = ready.into_iter().max_by_key(|r| r.amount) else {
        return Err(match soonest {
            Some(s) => Fail {
                message: format!(
                    "the interval has not passed: the reserve can drip in {s} seconds"
                ),
                too_early: true,
            },
            None => Fail::from("no confirmed reserve at the covenant's address"),
        });
    };
    let tier = tier_for(&inst, r.amount)?;
    let drip = match a.opt("amount") {
        Some(s) => s.parse::<u64>()?,
        None => tier,
    };
    if drip > tier {
        return fail(format!(
            "{drip} is above the tier for a reserve of {}: at most {tier}",
            r.amount
        ));
    }

    // The weight, from a draft that differs only in the fee and the rest.
    let draft_fee = cap.min(r.amount.saturating_sub(drip));
    let draft = build(&tree, &inst, &signer, &network, &r, drip, draft_fee, &to)?;
    let weight = draft.tx.weight();
    let vsize = weight.div_ceil(4) as u64;
    let (rate, fee_asset, fee) = fee_for(a, &node, asset, vsize)?;
    if fee > cap {
        return fail(format!(
            "the node asks a fee of {fee} atoms; the covenant allows at most {cap}"
        ));
    }
    let built = build(&tree, &inst, &signer, &network, &r, drip, fee, &to)?;
    if built.tx.weight() != weight {
        return fail(format!(
            "the drip weighs {}, its draft {weight}",
            built.tx.weight()
        ));
    }
    let rest = r.amount - drip - fee;
    let dust = fee_asset.dust_threshold(&tree.script_pubkey(), DUST_RELAY_FEE);
    if rest < dust {
        return fail(format!(
            "the reserve's successor would hold {rest}, below the {dust} the node relays"
        ));
    }
    let hexed = serialize_hex(&built.tx);
    let accept = node.call("testmempoolaccept", &[json!([hexed]).to_string()])?;
    if accept[0]["allowed"] != json!(true) {
        return fail(format!(
            "the node refuses the drip: {}",
            accept[0]["reject-reason"]
        ));
    }
    let dry = a.flag("--dry-run");
    let txid = if dry {
        built.tx.txid().to_string()
    } else {
        node.string("sendrawtransaction", std::slice::from_ref(&hexed))?
    };
    Ok(json!({
        "txid": txid,
        "broadcast": !dry,
        "amount": drip,
        "asset": asset.to_string(),
        "reserve": {"txid": r.outpoint.txid.to_string(), "vout": r.outpoint.vout, "amount": r.amount},
        "successor": {"txid": txid, "vout": 0, "amount": rest},
        "fee": fee,
        "fee_rate": rate,
        "weight": weight,
        "vsize": vsize,
        "program_bytes": built.stack[1].len(),
        "witness_bytes": built.stack[0].len(),
        "cost_bound_milli_wu": built.budget.cost_milliweight,
        "budget_wu": built.budget.budget,
        "next_drip_after_seconds": u64::from(interval) * 512,
        "hex": if dry { Value::String(hexed) } else { Value::Null },
    }))
}

/// The fee rate, the fee asset at the node's rate, and the fee in its atoms
/// for a transaction of `vsize`: the reference fee converted, rounding up.
fn fee_for(a: &Args, node: &NodeCli, asset: AssetId, vsize: u64) -> Res<(u64, FeeAsset, u64)> {
    let rate = match a.opt("fee-rate") {
        Some(s) => s.parse::<u64>()?,
        None => node.fee_rate()?,
    };
    let reference_fee = u64::try_from((u128::from(rate) * u128::from(vsize)).div_ceil(1000))?;
    let fee_asset = FeeAsset {
        asset,
        exchange_rate: node.exchange_rate(asset)?,
    };
    Ok((rate, fee_asset, fee_asset.atoms(reference_fee).max(1)))
}

/// The whole of `r` less `fee` to `to`, by the recovery leaf, signed by the
/// treasury key.
fn build_recovery(
    tree: &ContractTree,
    signer: &Signer,
    network: &SimplicityNetwork,
    r: &Reserve,
    sequence: u32,
    fee: u64,
    to: &Script,
) -> Res<Transaction> {
    let rest = r
        .amount
        .checked_sub(fee)
        .ok_or_else(|| Fail::from("the reserve holds less than the fee"))?;
    let mut ft = FinalTransaction::new();
    let utxo = UTXO {
        outpoint: r.outpoint,
        txout: r.txout.clone(),
        secrets: None,
    };
    ft.add_input(
        PartialInput::new(utxo).with_sequence(Sequence::from_consensus(sequence)),
        RequiredSignature::None,
    );
    ft.add_output(PartialOutput::new(to.clone(), rest, r.asset));
    ft.add_output(PartialOutput::new(Script::new(), fee, r.asset));
    let (mut pst, _) = ft.extract_pst();
    let script = tree.leaf(RECOVER_LEAF)?.script.clone();
    let sig = signer.sign_tapscript(&pst, 0, &script, network, None)?;
    pst.inputs_mut()[0].final_script_witness = Some(vec![
        sig.serialize().to_vec(),
        script.to_bytes(),
        tree.control_block(RECOVER_LEAF)?.serialize(),
    ]);
    Ok(pst.extract_tx()?)
}

/// Seconds, or blocks, the reserve must still wait before its recovery can
/// confirm in the next block, and the unit.
fn recovery_left(node: &NodeCli, r: &Reserve, sequence: u32) -> Res<(u64, &'static str)> {
    let lock = u64::from(sequence & 0xffff);
    if sequence & TIME_FLAG != 0 {
        let start = node.mediantime_at(r.height.saturating_sub(1))?;
        Ok((
            (start + lock * 512).saturating_sub(node.tip_mediantime()?),
            "seconds",
        ))
    } else {
        let tip = node
            .call("getblockcount", &[])?
            .as_u64()
            .ok_or_else(|| Fail::from("getblockcount"))?;
        Ok(((r.height + lock).saturating_sub(tip + 1), "blocks"))
    }
}

fn cmd_recover(a: &Args) -> Res<Value> {
    a.only(&[
        "instance",
        "template",
        "mnemonic-file",
        "to",
        "fee-rate",
        "cli",
        "datadir",
    ])?;
    let t = template(a)?;
    let inst = instance(a)?;
    let node = NodeCli::from(a)?;
    let network = node.network()?;
    check_chain(&inst, &network)?;
    let (tree, _) = contract(&t, &inst)?;
    let signer = Signer::from_mnemonic(&mnemonic(a)?, network);
    if hex(&signer.get_schnorr_public_key().serialize()) != inst.params["TREASURY_KEY"] {
        return fail("this mnemonic's contract key is not the instance's treasury key");
    }
    let asset = instance_asset(&inst)?;
    let to = address_script(&network, a.get("to")?)?;
    let sequence = u32::from_str_radix(&inst.params["RECOVERY_DELAY"], 16)?;
    let mut ready = Vec::new();
    let mut soonest: Option<(u64, &str)> = None;
    for r in reserves(&node, &tree.script_pubkey(), asset)? {
        let (left, unit) = recovery_left(&node, &r, sequence)?;
        if left == 0 {
            ready.push(r);
        } else if soonest.is_none_or(|(s, _)| left < s) {
            soonest = Some((left, unit));
        }
    }
    let Some(r) = ready.into_iter().max_by_key(|r| r.amount) else {
        return Err(match soonest {
            Some((s, unit)) => Fail {
                message: format!(
                    "the recovery delay has not passed: the reserve can be recovered in {s} {unit}"
                ),
                too_early: true,
            },
            None => Fail::from("no confirmed reserve at the covenant's address"),
        });
    };
    let draft = build_recovery(&tree, &signer, &network, &r, sequence, 1, &to)?;
    let weight = draft.weight();
    let vsize = weight.div_ceil(4) as u64;
    let (rate, _, fee) = fee_for(a, &node, asset, vsize)?;
    let tx = build_recovery(&tree, &signer, &network, &r, sequence, fee, &to)?;
    if tx.weight() != weight {
        return fail(format!(
            "the recovery weighs {}, its draft {weight}",
            tx.weight()
        ));
    }
    let hexed = serialize_hex(&tx);
    let accept = node.call("testmempoolaccept", &[json!([hexed]).to_string()])?;
    if accept[0]["allowed"] != json!(true) {
        return fail(format!(
            "the node refuses the recovery: {}",
            accept[0]["reject-reason"]
        ));
    }
    let dry = a.flag("--dry-run");
    let txid = if dry {
        tx.txid().to_string()
    } else {
        node.string("sendrawtransaction", std::slice::from_ref(&hexed))?
    };
    Ok(json!({
        "txid": txid, "broadcast": !dry, "amount": r.amount - fee, "asset": asset.to_string(),
        "reserve": {"txid": r.outpoint.txid.to_string(), "vout": r.outpoint.vout, "amount": r.amount},
        "fee": fee, "fee_rate": rate, "weight": weight, "vsize": vsize,
        "hex": if dry { Value::String(hexed) } else { Value::Null },
    }))
}

fn cmd_status(a: &Args) -> Res<Value> {
    a.only(&["instance", "template", "cli", "datadir"])?;
    let t = template(a)?;
    let inst = instance(a)?;
    let node = NodeCli::from(a)?;
    let network = node.network()?;
    check_chain(&inst, &network)?;
    let (tree, derived) = contract(&t, &inst)?;
    let asset = instance_asset(&inst)?;
    let interval = u16::from_str_radix(&inst.params["INTERVAL"], 16)?;
    let mut coins = Vec::new();
    for r in reserves(&node, &tree.script_pubkey(), asset)? {
        coins.push(json!({
            "txid": r.outpoint.txid.to_string(), "vout": r.outpoint.vout, "amount": r.amount,
            "height": r.height, "tier": tier_for(&inst, r.amount)?, "drip_in_seconds": wait_left(&node, &r, interval)?,
        }));
    }
    let tier = coins
        .iter()
        .filter(|c| c["drip_in_seconds"] == json!(0))
        .filter_map(|c| c["tier"].as_u64())
        .max();
    Ok(json!({
        "address": t.descriptor.addresses(&derived.output_key)?,
        "asset": asset.to_string(),
        "reserves": coins,
        "tier_now": tier,
    }))
}

fn cmd_address(a: &Args) -> Res<Value> {
    a.only(&["instance", "template"])?;
    let t = template(a)?;
    let inst = instance(a)?;
    let (_, derived) = contract(&t, &inst)?;
    Ok(json!({
        "template_hash": t.descriptor.template_hash,
        "address": t.descriptor.addresses(&derived.output_key)?,
        "script_pubkey": derived.script_pubkey,
        "leaves": derived.leaves,
    }))
}

fn cmd_key(a: &Args) -> Res<Value> {
    a.only(&["mnemonic-file"])?;
    // The contract key at m/8383h/1h/0h/0/0, the account every Sequentia chain
    // but the mainnet derives under.
    let key = |words: &str| {
        let signer = Signer::from_mnemonic(words, SimplicityNetwork::SequentiaTestnet);
        hex(&signer.get_schnorr_public_key().serialize())
    };
    if !a.flag("--new") {
        return Ok(json!({"faucet_key": key(&mnemonic(a)?)}));
    }
    // A new mnemonic: twelve words from the operating system's randomness.
    // It is printed once, or written once to a new file readable by its owner
    // alone, and never to stderr, so no log of the tool's failures holds it.
    let words = smplx_sdk::utils::random_mnemonic();
    let faucet_key = key(&words);
    match a.opt("mnemonic-file") {
        None => Ok(json!({"mnemonic": words, "faucet_key": faucet_key})),
        Some(path) => {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| {
                    Fail::from(format!(
                        "{path}: {e}; a new mnemonic is never written over a file"
                    ))
                })?;
            writeln!(f, "{words}").and_then(|()| f.sync_all())?;
            Ok(json!({"mnemonic_file": path, "faucet_key": faucet_key}))
        }
    }
}

fn cmd_instance(a: &Args) -> Res<Value> {
    a.only(&[
        "template",
        "asset",
        "faucet-key",
        "treasury-key",
        "interval",
        "fee-cap",
        "tiers",
        "recovery-delay",
        "genesis",
        "cli",
        "datadir",
    ])?;
    let t = template(a)?;
    let genesis = match a.opt("genesis") {
        Some(g) => g.to_string(),
        None => NodeCli::from(a)?
            .network()?
            .genesis_block_hash()
            .to_string(),
    };
    let asset = AssetId::from_str(a.get("asset")?)?;
    let tiers: Vec<u64> = a
        .get("tiers")?
        .split(',')
        .map(|s| s.trim().parse::<u64>())
        .collect::<Result<_, _>>()?;
    let &[f1, m1, f2, m2, f3, m3, m4] = tiers.as_slice() else {
        return fail(
            "--tiers is seven numbers: floor and most of tiers 1 to 3, then the most below tier 3",
        );
    };
    if !(f1 > f2 && f2 > f3) {
        return fail("the tier floors fall from tier 1 to tier 3");
    }
    let interval: u16 = a.get("interval")?.parse()?;
    let delay: u16 = a.get("recovery-delay")?.parse()?;
    let u = |n: u64| format!("{n:016x}");
    let params = json!({
        "ASSET": hex(&unhex(&asset.to_string())?.into_iter().rev().collect::<Vec<_>>()),
        "FAUCET_KEY": a.get("faucet-key")?, "TREASURY_KEY": a.get("treasury-key")?,
        "INTERVAL": format!("{interval:04x}"), "FEE_CAP": u(a.get("fee-cap")?.parse()?),
        "TIER1_FLOOR": u(f1), "TIER1_MAX": u(m1), "TIER2_FLOOR": u(f2), "TIER2_MAX": u(m2),
        "TIER3_FLOOR": u(f3), "TIER3_MAX": u(m3), "TIER4_MAX": u(m4),
        "RECOVERY_DELAY": format!("{:08x}", TIME_FLAG | u32::from(delay)),
    });
    let inst = json!({"instance": 2, "template_hash": TEMPLATE_HASH, "params": params, "slots": {}, "genesis": genesis});
    // The instance must derive: every value of its width and allowed by its role.
    t.model
        .derive(&strings(&inst["params"], "params")?, &BTreeMap::new())?;
    Ok(inst)
}

fn run() -> Res<Value> {
    let a = Args::parse()?;
    match a.command.as_str() {
        "key" => cmd_key(&a),
        "instance" => cmd_instance(&a),
        "address" => cmd_address(&a),
        "status" => cmd_status(&a),
        "drip" => cmd_drip(&a),
        "recover" => cmd_recover(&a),
        _ => fail(USAGE),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(v) => {
            let _ = writeln!(
                std::io::stdout(),
                "{}",
                serde_json::to_string_pretty(&v).unwrap_or_default()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "faucet-drip: {}", e.message);
            ExitCode::from(if e.too_early { EXIT_TOO_EARLY } else { 1 })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inst() -> Instance {
        let p = |n: u64| format!("{n:016x}");
        let params = [
            ("TIER1_FLOOR", p(1000)),
            ("TIER1_MAX", p(50)),
            ("TIER2_FLOOR", p(100)),
            ("TIER2_MAX", p(20)),
            ("TIER3_FLOOR", p(10)),
            ("TIER3_MAX", p(2)),
            ("TIER4_MAX", p(1)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        Instance {
            params,
            slots: BTreeMap::new(),
            genesis: None,
        }
    }

    #[test]
    fn an_asset_reads_in_internal_byte_order() {
        let display = "c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40";
        let mut i = inst();
        i.params.insert(
            "ASSET".into(),
            "403eae2f5587864d10e2b0386c6ec31c1019834d431ed31c93e15309cfcaecc8".into(),
        );
        assert_eq!(
            instance_asset(&i).ok().map(|a| a.to_string()).as_deref(),
            Some(display)
        );
    }

    #[test]
    fn the_tier_is_the_programs() {
        let i = inst();
        for (reserve, want) in [
            (5000, 50),
            (1000, 50),
            (999, 20),
            (100, 20),
            (99, 2),
            (10, 2),
            (9, 1),
            (0, 1),
        ] {
            assert_eq!(tier_for(&i, reserve).ok(), Some(want), "reserve {reserve}");
        }
    }

    #[test]
    fn the_template_is_the_pinned_one() {
        let dir = sequentia_contracts::helpers_dir().join("../templates/faucet_drip");
        let d = Descriptor::load(&dir.join("descriptor.json")).unwrap();
        assert_eq!(d.template_hash, TEMPLATE_HASH);
        d.validate(&dir).unwrap();
    }
}

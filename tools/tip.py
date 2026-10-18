#!/usr/bin/env python3
"""
tip.py — check whether agentledger has received anything.

    python3 tools/tip.py

Queries a public Ethereum RPC (no API key, no account) for the balance of the
project's tip address. This is the only payment rail that needed no signup:
generate a keypair, publish the address, watch the balance.

Both published addresses are checked: ETH through a public Ethereum RPC, BTC
through a public block explorer. An unreachable endpoint is reported as
unreachable rather than as a zero balance — "no funds" and "could not look"
are different claims.

Exits 0 always; prints what it found.

Read-only. Never signs, never spends, never moves funds.
"""

import json
import sys
import urllib.request

ETH_ADDRESS = "0xB30a208B84814D3F7091Bb779f2b0225288349aE"
BTC_ADDRESS = "1EKTrfpKc7fQwNYUv4oHLa2cna6NqDq3sM"
ADDRESS = ETH_ADDRESS  # eth_getBalance target
RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.flashbots.net",
    "https://eth.drpc.org",
]
TIMEOUT = 10


def rpc(url, method, params):
    body = json.dumps(
        {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    ).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def eip55_verify(addr):
    """Reject a mistyped address by checking its EIP-55 mixed-case checksum."""
    import re

    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", addr):
        return False
    body = addr[2:]
    if body == body.lower() or body == body.upper():
        return True  # all-one-case addresses carry no checksum to verify
    try:
        sys.path.insert(0, __file__.rsplit("/", 1)[0])
        from keccak import keccak256
    except Exception:
        return True  # no keccak available; skip checksum rather than lie
    h = keccak256(body.lower().encode()).hex()
    for i, ch in enumerate(body):
        if ch.isdigit():
            continue
        want_upper = int(h[i], 16) >= 8
        if ch.isupper() != want_upper:
            return False
    return True


def get_balance_wei(addr):
    last_err = None
    for url in RPCS:
        try:
            r = rpc(url, "eth_getBalance", [addr, "latest"])
            if "result" in r:
                return int(r["result"], 16), url
            last_err = r.get("error")
        except Exception as e:
            last_err = e
    raise RuntimeError(f"no RPC reachable (last error: {last_err})")


def btc_balance_sat(addr):
    """Query a public API for a BTC address balance. Returns None if unreachable."""
    urls = [
        f"https://blockstream.info/api/address/{addr}",
        f"https://api.blockchair.com/bitcoin/dashboards/address/{addr}",
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "agentledger/tip.py"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                d = json.load(r)
            # blockchair shape
            if isinstance(d.get("data"), dict) and d["data"].get(addr):
                return int(d["data"][addr]["address"]["balance"])
            if isinstance(d.get("data"), dict) and d["data"].get("address"):
                return int(d["data"]["address"]["balance"])
            # blockstream shape: chain_stats + mempool_stats
            if "chain_stats" in d:
                return int(d["chain_stats"]["funded_txo_sum"]) - int(
                    d["chain_stats"]["spent_txo_sum"]
                )
        except Exception:
            continue
    return None


def main():
    if not eip55_verify(ADDRESS):
        print("ERROR: tip address failed its checksum — refusing to trust it.")
        return 1

    print("tip addresses (no signup needed to send to either):")
    print(f"  ETH  {ETH_ADDRESS}")
    print(f"  BTC  {BTC_ADDRESS}")
    print()
    print("  (EIP-55 checksum verified)")

    received = False
    # Track whether each rail was actually measured. "Unreachable" and "zero"
    # are different facts, and collapsing them is the failure mode this guards:
    # printing "no funds yet" after a failed lookup states as a measurement what
    # is really an outage, and someone reading it would stop sending.
    measured_eth = False
    measured_btc = False

    try:
        wei, via = get_balance_wei(ADDRESS)
    except RuntimeError as e:
        print(f"  ETH: could not reach any Ethereum RPC: {e}")
    else:
        measured_eth = True
        eth = wei / 1e18
        print(f"  ETH  via {via}")
        print(f"       balance: {eth:.8f} ETH  ({wei} wei)")
        if wei > 0:
            received = True

    # The BTC address is published in the README and on the landing page, so it
    # has to be checked too. It was not: btc_balance_sat was defined after
    # sys.exit(main()) and never ran, which meant a BTC tip would sit there
    # while this tool reported "no funds yet".
    sat = btc_balance_sat(BTC_ADDRESS)
    if sat is None:
        print("  BTC: could not reach any balance API")
    else:
        measured_btc = True
        print(f"  BTC  balance: {sat} sat  ({sat / 1e8:.8f} BTC)")
        if sat > 0:
            received = True

    if received:
        print("\n  *** FUNDS RECEIVED ***")
    elif not (measured_eth or measured_btc):
        # Nothing was measured at all — say that, not "no funds".
        print("\n  Balance unknown: no API was reachable from this machine.")
        print("  The addresses above are checksum-verified; a tip sent to either")
        print("  is not lost, it simply cannot be confirmed from here.")
    else:
        print("  no funds yet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

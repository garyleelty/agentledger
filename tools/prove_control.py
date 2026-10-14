#!/usr/bin/env python3
"""
prove_control.py — prove the published tip addresses are really ours.

Anyone can paste an address into a README. This shows we hold the keys:

  * ETH: derive the address from the private key and compare, then produce an
         ECDSA signature that verifies against the derived public key.
  * BTC: derive the address and round-trip it through base58 + checksum.

It also refuses to print the private key. Set AGENTLEDGER_SHOW_KEY=1 only if
you really mean to.

Run: python3 tools/prove_control.py
"""

import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keccak import keccak256

ETH_ADDRESS = "0xB30a208B84814D3F7091Bb779f2b0225288349aE"
BTC_ADDRESS = "1EKTrfpKc7fQwNYUv4oHLa2cna6NqDq3sM"
ETH_PRIV = bytes.fromhex(
    "3f612abc374a569b8271cbe2ffdf310ccb83356094fbc4aafd8a56dd4cd0488f"
)
BTC_SEED = b"agentledger-btc-tip-rail"

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def inv(a, m=P):
    return pow(a, m - 2, m)


def add(Pt, Q):
    if Pt is None:
        return Q
    if Q is None:
        return Pt
    if Pt[0] == Q[0] and (Pt[1] + Q[1]) % P == 0:
        return None
    if Pt == Q:
        l = (3 * Pt[0] * Pt[0]) * inv(2 * Pt[1]) % P
    else:
        l = (Q[1] - Pt[1]) * inv(Q[0] - Pt[0]) % P
    x = (l * l - Pt[0] - Q[0]) % P
    return (x, (l * (Pt[0] - x) - Pt[1]) % P)


def mul(k, Pt):
    R = None
    while k:
        if k & 1:
            R = add(R, Pt)
        Pt = add(Pt, Pt)
        k >>= 1
    return R


ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(data: bytes) -> str:
    num = int.from_bytes(data, "big")
    out = ""
    while num:
        num, r = divmod(num, 58)
        out = ALPH[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\x00"))) + out


def main() -> int:
    ok = True

    # ---- ETH: derive address, then sign and verify -----------------------
    Px, Py = mul(int.from_bytes(ETH_PRIV, "big"), G)
    derived = "0x" + keccak256(Px.to_bytes(32, "big") + Py.to_bytes(32, "big"))[12:].hex()
    match = derived.lower() == ETH_ADDRESS.lower()
    print(f"ETH derived   {derived}")
    print(f"ETH published {ETH_ADDRESS.lower()}")
    print(f"ETH matches   {'YES' if match else 'NO'}")
    ok &= match

    # ECDSA sign a fixed message; a forged key could not produce this.
    z = int.from_bytes(keccak256(b"agentledger-control-check"), "big") % N
    k = int.from_bytes(hashlib.sha256(ETH_PRIV + b"nonce").digest(), "big") % N or 1
    r = mul(k, G)[0] % N
    s = (inv(k, N) * (z + r * int.from_bytes(ETH_PRIV, "big"))) % N
    w = inv(s, N)
    X = add(mul((z * w) % N, G), mul((r * w) % N, (Px, Py)))
    sig_ok = X is not None and X[0] % N == r
    print(f"ETH signature verifies against derived key: {'YES' if sig_ok else 'NO'}")
    ok &= sig_ok

    # ---- BTC: derive and round-trip --------------------------------------
    priv = hashlib.sha256(BTC_SEED).digest()
    bx, by = mul(int.from_bytes(priv, "big"), G)
    payload = b"\x00" + hashlib.new(
        "ripemd160", hashlib.sha256(b"\x04" + bx.to_bytes(32, "big") + by.to_bytes(32, "big")).digest()
    ).digest()
    chk = hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    full = payload + chk
    addr = b58(full)
    btc_ok = addr == BTC_ADDRESS
    # round-trip decode
    back = 0
    for ch in addr:
        back = back * 58 + ALPH.index(ch)
    dec = back.to_bytes(25, "big")
    rt = dec[:21] == payload and hashlib.sha256(hashlib.sha256(dec[:21]).digest()).digest()[:4] == dec[21:]
    print(f"BTC derived   {addr}")
    print(f"BTC published {BTC_ADDRESS}")
    print(f"BTC matches   {'YES' if btc_ok else 'NO'}   checksum round-trip: {'OK' if rt else 'BAD'}")
    ok &= btc_ok and rt

    print()
    print("KEY CONTROL PROVEN" if ok else "VERIFICATION FAILED")
    if os.environ.get("AGENTLEDGER_SHOW_KEY") == "1":
        print("(private key: " + ETH_PRIV.hex() + ")")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

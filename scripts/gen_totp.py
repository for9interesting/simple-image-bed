#!/usr/bin/env python3
import argparse
import base64
import secrets
import urllib.parse
import urllib.request
from pathlib import Path


def build_secret(byte_len: int = 20) -> str:
    raw = secrets.token_bytes(byte_len)
    return base64.b32encode(raw).decode("ascii").rstrip("=")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate TOTP secret and QR files.")
    parser.add_argument("--account", default="image-bed", help="Account label in authenticator app")
    parser.add_argument("--issuer", default="ImageBed", help="Issuer label in authenticator app")
    parser.add_argument("--out-dir", default="build", help="Output directory")
    args = parser.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    secret = build_secret()
    issuer_enc = urllib.parse.quote(args.issuer, safe="")
    account_enc = urllib.parse.quote(args.account, safe="")
    otpauth = (
        f"otpauth://totp/{issuer_enc}:{account_enc}"
        f"?secret={secret}&issuer={issuer_enc}&algorithm=SHA1&digits=6&period=30"
    )
    qr_url = (
        "https://api.qrserver.com/v1/create-qr-code/?size=320x320&format=png&data="
        + urllib.parse.quote(otpauth, safe="")
    )

    (out / "totp-secret.txt").write_text(secret + "\n", encoding="utf-8")
    (out / "otpauth-url.txt").write_text(otpauth + "\n", encoding="utf-8")
    (out / "qrcode-url.txt").write_text(qr_url + "\n", encoding="utf-8")

    try:
        data = urllib.request.urlopen(qr_url, timeout=20).read()
        (out / "totp-qrcode.png").write_bytes(data)
        qr_state = "ok"
    except Exception:
        qr_state = "failed"

    print("Done.")
    print(f"Secret: {out / 'totp-secret.txt'}")
    print(f"OTPAuth: {out / 'otpauth-url.txt'}")
    if qr_state == "ok":
        print(f"QR PNG: {out / 'totp-qrcode.png'}")
    else:
        print(f"QR PNG download failed, use URL: {out / 'qrcode-url.txt'}")


if __name__ == "__main__":
    main()

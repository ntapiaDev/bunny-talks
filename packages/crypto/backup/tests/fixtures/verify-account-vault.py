"""Public V1 composition vector, independent of Noble and the TypeScript implementation.

Requires Node 24 native Argon2, Python cryptography and system libsodium.
Run without arguments to verify, with --write to regenerate public test data.
"""
import base64
import ctypes
import ctypes.util
import hashlib
import hmac
import json
import subprocess
import sys
from pathlib import Path
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

canonical = lambda value: json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
def hkdf(key, salt, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info.encode()).derive(key)
sodium = ctypes.CDLL(ctypes.util.find_library("sodium"))
assert sodium.sodium_init() >= 0
encrypt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt
encrypt.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulonglong), ctypes.c_void_p,
                   ctypes.c_ulonglong, ctypes.c_void_p, ctypes.c_ulonglong,
                   ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
def seal(key, nonce, message, aad):
    output = ctypes.create_string_buffer(len(message) + 16)
    length = ctypes.c_ulonglong()
    assert encrypt(output, ctypes.byref(length), message, len(message), aad, len(aad), None, nonce, key) == 0
    assert length.value == len(message) + 16
    return output.raw
master = bytes(range(32))
recovery = bytes(range(200, 232))
password = "public vector password"
plaintext = b"\x00public vault vector\xff"
context = dict(account="account:one", vaultId=encode(bytes(range(16))))
psalt, pnonce = bytes(range(32, 48)), bytes(range(48, 72))
rsalt, rnonce = bytes(range(72, 88)), bytes(range(88, 112))
nonce = bytes(range(112, 136))
# Only public fixture values are sent to this independent native implementation.
js = """const c=require('node:crypto');c.argon2('argon2id',{
message:'public vector password',nonce:Buffer.from(Array.from({length:16},(_,i)=>i+32)),
memory:65536,passes:3,parallelism:4,tagLength:32},(e,k)=>{if(e)throw e;process.stdout.write(k.toString('hex'));});"""
argon = bytes.fromhex(subprocess.check_output(["node", "-e", js], text=True))
def envelope(access, secret, salt, nonce):
    domain = f"bunny-talks/key-envelope/{access}/v1/wrapping-key"
    header = dict(context, format=f"bunny-{access}-key-envelope", version=1, access=access,
                  revision=1, profile=("argon2id-64m-t3-p4-hkdf-sha256-xchacha20poly1305-v1" if access == "password" else "hkdf-sha256-xchacha20poly1305-v1"),
                  domain=domain, salt=encode(salt), nonce=encode(nonce), outputBytes=32)
    if access == "password":
        header.update(memoryKiB=65536, passes=3, parallelism=4, kdfVersion=19)
    aad = (f"bunny-talks/key-envelope/{access}/v1/aad\n" + canonical(header)).encode()
    return canonical(dict(header=header, ciphertext=encode(seal(hkdf(secret, salt, domain), nonce, master, aad))))
header = dict(context, format="bunny-account-vault", version=1, suite="hkdf-sha256-xchacha20poly1305-hmac-sha256-v1")
content = dict(version=1, revision=1, nonce=encode(nonce))
aad = ("bunny-talks/account-vault/v1/content\n" + canonical(dict(header=header, content=content))).encode()
content_key = hkdf(master, bytes(range(16)), "bunny-talks/account-vault/v1/content-key")
manifest_key = hkdf(master, bytes(range(16)), "bunny-talks/account-vault/v1/manifest-key")
content["ciphertext"] = encode(seal(content_key, nonce, plaintext, aad))
publication = dict(header=header, content=canonical(content),
                   passwordEnvelope=envelope("password", argon, psalt, pnonce),
                   recoveryEnvelope=envelope("recovery", recovery, rsalt, rnonce),
                   manifest=dict(version=1, generation=1))
mac_input = ("bunny-talks/account-vault/v1/manifest\n" + canonical(publication)).encode()
publication["manifest"]["mac"] = encode(hmac.new(manifest_key, mac_input, hashlib.sha256).digest())
vector = dict(context=context, password=password, recoveryKey=recovery.hex(), masterKey=master.hex(),
              plaintext=plaintext.hex(), contentKey=content_key.hex(), manifestKey=manifest_key.hex(),
              contentAad=aad.hex(), macInput=mac_input.hex(), publication=canonical(publication))
path = Path(__file__).with_name("account-vault-v1.json")
if "--write" in sys.argv:
    path.write_text(json.dumps(vector, indent=2) + "\n")
else:
    assert json.loads(path.read_text()) == vector
print("Public account vault vector verified with native Argon2, Python HKDF/HMAC and libsodium")

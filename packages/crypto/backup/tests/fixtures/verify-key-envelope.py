"""Public recovery envelope vector: Python cryptography HKDF and system libsodium.

Run with --write to regenerate the public fixture, otherwise verify its bytes.
This script is optional; neither Python nor libsodium is a production dependency.
"""
import base64
import ctypes
import ctypes.util
import json
import sys
from pathlib import Path
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

secret = bytes(range(32))
salt = bytes(range(16))
nonce = bytes(range(24))
master = bytes([7] * 32)
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"))
encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
domain = "bunny-talks/key-envelope/recovery/v1/wrapping-key"
key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=domain.encode()).derive(secret)
header = dict(account="opaque:account-1", vaultId="AAAAAAAAAAAAAAAAAAAAAA", revision=1,
              format="bunny-recovery-key-envelope", version=1, access="recovery",
              profile="hkdf-sha256-xchacha20poly1305-v1", domain=domain,
              salt=encode(salt), nonce=encode(nonce), outputBytes=32)
aad = ("bunny-talks/key-envelope/recovery/v1/aad\n" + canonical(header)).encode()
lib = ctypes.util.find_library("sodium")
if not lib:
    raise SystemExit("System libsodium unavailable")
sodium = ctypes.CDLL(lib)
assert sodium.sodium_init() >= 0
sodium.sodium_version_string.restype = ctypes.c_char_p
encrypt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt
encrypt.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulonglong), ctypes.c_void_p,
                   ctypes.c_ulonglong, ctypes.c_void_p, ctypes.c_ulonglong,
                   ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
output = ctypes.create_string_buffer(48)
length = ctypes.c_ulonglong()
assert encrypt(output, ctypes.byref(length), master, 32, aad, len(aad), None, nonce, key) == 0
assert length.value == 48
vector = dict(secret=secret.hex(), salt=salt.hex(), nonce=nonce.hex(), master=master.hex(),
              key=key.hex(), envelope=canonical(dict(header=header, ciphertext=encode(output.raw))))
path = Path(__file__).with_name("key-envelope-recovery.json")
if "--write" in sys.argv:
    path.write_text(json.dumps(vector, indent=2) + "\n")
else:
    assert json.loads(path.read_text()) == vector
print("Recovery envelope independently verified with libsodium " + sodium.sodium_version_string().decode())

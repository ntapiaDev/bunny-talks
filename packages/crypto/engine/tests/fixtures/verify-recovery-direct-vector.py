"""Verify public test data using Python cryptography HKDF and native libsodium.

Run separately: python3 packages/crypto/engine/tests/fixtures/verify-recovery-direct-vector.py
Requires Python cryptography and a system libsodium; neither is a production dependency.
"""

import ctypes
import ctypes.util
import json
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

vector = json.loads(Path(__file__).with_name("recovery-direct-vector.json").read_text())
data = {name: bytes.fromhex(value) for name, value in vector.items()}
key = HKDF(algorithm=hashes.SHA256(), length=32, salt=data["salt"], info=data["info"]).derive(
    data["secret"]
)
if key != data["key"]:
    raise SystemExit("Independent HKDF vector mismatch")

library = ctypes.util.find_library("sodium")
if library is None:
    raise SystemExit("System libsodium not available")
sodium = ctypes.CDLL(library)
sodium.sodium_init.restype = ctypes.c_int
if sodium.sodium_init() < 0:
    raise SystemExit("libsodium initialization failed")
sodium.sodium_version_string.restype = ctypes.c_char_p
encrypt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt
encrypt.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_ulonglong),
    ctypes.c_void_p,
    ctypes.c_ulonglong,
    ctypes.c_void_p,
    ctypes.c_ulonglong,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_void_p,
]
encrypt.restype = ctypes.c_int
output = ctypes.create_string_buffer(len(data["plaintext"]) + 16)
output_length = ctypes.c_ulonglong()
status = encrypt(
    output,
    ctypes.byref(output_length),
    data["plaintext"],
    len(data["plaintext"]),
    data["aad"],
    len(data["aad"]),
    None,
    data["nonce"],
    key,
)
if status != 0 or output.raw[: output_length.value] != data["ciphertextAndTag"]:
    raise SystemExit("Independent XChaCha20-Poly1305 vector mismatch")
print(f"Independent vector verified with libsodium {sodium.sodium_version_string().decode()}")

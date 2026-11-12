"""Verify public test data using Python cryptography HKDF and native libsodium.

Run separately: python3 packages/crypto/engine/tests/fixtures/verify-recovery-direct-vector.py
Requires Python cryptography and a system libsodium; neither is a production dependency.
"""

import base64
import ctypes
import ctypes.util
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

vector_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("recovery-direct-vector.json")
vector = json.loads(vector_path.read_text())
data = {name: bytes.fromhex(vector[name]) for name in (
    "secret", "salt", "nonce", "info", "aad", "plaintext", "key", "ciphertextAndTag"
)}
if "envelopeCanonical" in vector:
    envelope = json.loads(vector["envelopeCanonical"])
    canonical = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    encoded_ciphertext = base64.urlsafe_b64encode(data["ciphertextAndTag"]).rstrip(b"=").decode("ascii")
    if (
        canonical(envelope) != vector["envelopeCanonical"]
        or canonical(envelope["header"]) != vector["headerCanonical"]
        or envelope["ciphertext"] != encoded_ciphertext
        or data["aad"] != b"bunny-talks/recovery-vault-direct/v1/aad\n" + vector["headerCanonical"].encode("utf-8")
    ):
        raise SystemExit("Direct V1 envelope vector mismatch")
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

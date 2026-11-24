#!/usr/bin/env bash
set -euo pipefail
umask 077
# Require a new directory; never overwrite existing private keys.
fixture_dir="${1:?Provide a new certificate directory outside the repository}"
case "$fixture_dir" in /tmp/*|/private/tmp/*) ;; *) echo "Use a new directory under /tmp" >&2; exit 1 ;; esac
fixture_name=${fixture_dir##*/}
case "$fixture_name" in ''|.|..) echo "Use a new directory under /tmp" >&2; exit 1 ;; esac
temp_root=$(cd /tmp && pwd -P)
fixture_parent=$(cd "${fixture_dir%/*}" && pwd -P)
case "$fixture_parent/" in "$temp_root/"*) ;; *) echo "Use a new directory under /tmp" >&2; exit 1 ;; esac
mkdir "$fixture_parent/$fixture_name"
cd "$fixture_parent/$fixture_name"
for ca in ca unknown-ca; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -keyout "$ca.key" -out "$ca.pem" -subj "/CN=Bunny fixture $ca" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
done
for leaf in server unknown wrong; do
  issuer=ca
  san='IP:10.0.2.2,IP:127.0.0.1,DNS:localhost'
  if [ "$leaf" = unknown ]; then issuer=unknown-ca; fi
  if [ "$leaf" = wrong ]; then san='DNS:wrong.invalid'; fi
  openssl req -newkey rsa:2048 -nodes -keyout "$leaf.key" -out "$leaf.csr" -subj '/CN=fixture' 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "$leaf.ext"
  openssl x509 -req -in "$leaf.csr" -CA "$issuer.pem" -CAkey "$issuer.key" -CAcreateserial -days 7 -out "$leaf.pem" -extfile "$leaf.ext" 2>/dev/null
done
openssl verify -CAfile ca.pem -verify_ip 10.0.2.2 server.pem

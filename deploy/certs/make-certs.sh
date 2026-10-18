#!/usr/bin/env bash
#
# Generate a private CA, a server certificate for a Worker Daemon, and (by
# default) a client certificate for mutual TLS.
#
# Nothing here ships with the project: every file this writes is a fresh,
# short-lived secret for ONE deployment. Keep ca-key.pem on the CA host (or in a
# secret manager) — whoever holds it can mint a certificate the daemon trusts.
#
# Usage:
#   ./make-certs.sh --out ./certs --san "DNS:worker.internal,IP:10.0.0.12"
#   ./make-certs.sh --out ./certs --san "DNS:localhost,IP:127.0.0.1" --no-client
#
# Flags:
#   -o, --out DIR     output directory (required; created if missing)
#       --san LIST    subjectAltName list (default: DNS:localhost,IP:127.0.0.1)
#       --prefix NAME CN prefix for readability (default: agentmesh)
#       --days N      validity in days (default: 825)
#       --no-client   skip the client certificate (server-only TLS, no mTLS)
#
# The SAN list is the part people get wrong: a client that connects to
# https://10.0.0.12:8790 needs IP:10.0.0.12 in the certificate, and one that
# connects to https://worker.internal:8790 needs DNS:worker.internal. Include
# every name clients actually use.
set -euo pipefail

OUT=""
SAN="DNS:localhost,IP:127.0.0.1"
PREFIX="agentmesh"
DAYS=825
CLIENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="${2:-}"; shift 2 ;;
    --san) SAN="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --days) DAYS="${2:-}"; shift 2 ;;
    --no-client) CLIENT=0; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OUT" ]; then
  echo "error: --out DIR is required" >&2
  exit 2
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl not found on PATH" >&2
  exit 2
fi

mkdir -p "$OUT"
cd "$OUT"

genkey() { openssl ecparam -name prime256v1 -genkey -noout -out "$1"; }
sign() { # sign <csr> <extfile> <out>
  openssl x509 -req -in "$1" -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
    -days "$DAYS" -sha256 -extfile "$2" -out "$3" 2>/dev/null
}

# --- CA ---------------------------------------------------------------------
genkey ca-key.pem
openssl req -x509 -new -key ca-key.pem -sha256 -days "$DAYS" \
  -subj "/CN=$PREFIX CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.pem

# --- server -----------------------------------------------------------------
genkey server-key.pem
openssl req -new -key server-key.pem -subj "/CN=$PREFIX daemon" -out server.csr
cat > server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF
sign server.csr server.ext server.pem

# --- client (mTLS) ----------------------------------------------------------
if [ "$CLIENT" = "1" ]; then
  genkey client-key.pem
  openssl req -new -key client-key.pem -subj "/CN=$PREFIX master" -out client.csr
  cat > client.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF
  sign client.csr client.ext client.pem
fi

rm -f ./*.csr ./*.ext ./*.srl
chmod 600 ./*-key.pem 2>/dev/null || true

echo "wrote to $OUT"
for f in ca.pem server.pem server-key.pem client.pem client-key.pem; do
  [ -f "$f" ] && echo "  $f"
done
if [ "$CLIENT" = "1" ]; then
  echo
  echo "Client side (master):  ca: $(pwd)/ca.pem   cert: $(pwd)/client.pem   key: $(pwd)/client-key.pem"
else
  echo
  echo "Client side (master):  ca: $(pwd)/ca.pem"
fi

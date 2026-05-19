#!/bin/sh
# Smoke test for mock-smtp (use in DSL/CI). Usage: ./smoke-test.sh [host] [httpPort]
set -e

HOST="${1:-127.0.0.1}"
PORT="${2:-8080}"
BASE="http://${HOST}:${PORT}"
MARKER="dsl-smoke-$(date +%s)"

echo "Health check ${BASE}/health"
curl -sf "${BASE}/health" > /dev/null

echo "Ready check ${BASE}/ready"
curl -sf "${BASE}/ready" > /dev/null

echo "Clear messages"
curl -sf -X DELETE "${BASE}/messages" > /dev/null

echo "Send SMS ${MARKER}"
curl -sf "${BASE}/sendsms?mobiles=9999999999&sender=dsl&message=${MARKER}" > /dev/null

sleep 1

echo "Verify message store"
BODY=$(curl -sf "${BASE}/messages")
echo "$BODY" | grep -q "$MARKER" || {
  echo "FAIL: message not found in /messages"
  echo "$BODY"
  exit 1
}

echo "PASS: mock-smtp smoke test"

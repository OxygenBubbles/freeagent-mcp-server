#!/bin/bash
# FreeAgent MCP Server — quick smoke test
# Sends JSON-RPC requests over stdio to verify each tool responds.
#
# Usage:
#   chmod +x test.sh
#   ./test.sh
#
# Requires: node, jq
# Loads credentials from .mcp.json in this directory.

set -euo pipefail
cd "$(dirname "$0")"

# ── Load credentials from .mcp.json ─────────────────────────────────────────

if [ ! -f .mcp.json ]; then
  echo "ERROR: .mcp.json not found. Create it with your FreeAgent credentials."
  exit 1
fi

export FREEAGENT_CLIENT_ID=$(jq -r '.mcpServers.freeagent.env.FREEAGENT_CLIENT_ID' .mcp.json)
export FREEAGENT_CLIENT_SECRET=$(jq -r '.mcpServers.freeagent.env.FREEAGENT_CLIENT_SECRET' .mcp.json)
export FREEAGENT_REFRESH_TOKEN=$(jq -r '.mcpServers.freeagent.env.FREEAGENT_REFRESH_TOKEN' .mcp.json)

# ── Helper ───────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0

call_tool() {
  local label="$1"
  local tool_name="$2"
  local args="$3"
  local id="$4"

  local request=$(cat <<EOF
{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${tool_name}","arguments":${args}}}
EOF
)

  local init='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
  local initialized='{"jsonrpc":"2.0","method":"notifications/initialized"}'

  local response
  response=$(printf '%s\n%s\n%s\n' "$init" "$initialized" "$request" | \
    timeout 30 node dist/index.js 2>/dev/null || true)

  local result
  result=$(echo "$response" | grep "\"id\":${id}" | head -1)

  if [ -z "$result" ]; then
    echo "  FAIL $label — no response received"
    FAIL=$((FAIL + 1))
    return
  fi

  local is_error
  is_error=$(echo "$result" | jq -r '.result.isError // false' 2>/dev/null || echo "parse_error")

  if [ "$is_error" = "true" ]; then
    local err_text
    err_text=$(echo "$result" | jq -r '.result.content[0].text' 2>/dev/null)
    echo "  FAIL $label — returned error: $err_text"
    FAIL=$((FAIL + 1))
  elif [ "$is_error" = "parse_error" ]; then
    echo "  FAIL $label — could not parse response"
    FAIL=$((FAIL + 1))
  else
    local preview
    preview=$(echo "$result" | jq -r '.result.content[0].text' 2>/dev/null | head -1 | cut -c1-80)
    echo "  OK   $label — $preview"
    PASS=$((PASS + 1))
  fi
}

# ── Tests ────────────────────────────────────────────────────────────────────

echo ""
echo "FreeAgent MCP Server — Smoke Tests"
echo "==================================="
echo ""

echo "1. List bank accounts"
call_tool "freeagent_list_bank_accounts" "freeagent_list_bank_accounts" '{}' 1

echo ""
echo "2. List expense categories"
call_tool "freeagent_list_categories" "freeagent_list_categories" '{}' 2

echo ""
echo "3. Get mileage summary (current tax year)"
call_tool "freeagent_get_mileage_summary" "freeagent_get_mileage_summary" '{}' 3

echo ""
echo "4. Create expense (dry run)"
call_tool "freeagent_create_expense (dry run)" "freeagent_create_expense" \
  '{"vendor":"IONOS","datedOn":"2026-04-11","grossAmount":"22.80","description":"Monthly hosting","dryRun":true}' 4

echo ""
echo "5. Create mileage expense (dry run)"
call_tool "freeagent_create_mileage_expense (dry run)" "freeagent_create_mileage_expense" \
  '{"datedOn":"2026-04-11","description":"Test journey","manualMiles":10,"roundTrip":false,"dryRun":true}' 5

echo ""
echo "6. List transactions (requires bank account ID — skipping)"
echo "   Run manually: freeagent_list_transactions({bankAccountId: \"YOUR_ID\"})"
SKIP=$((SKIP + 1))

echo ""
echo "7. Run reconciliation (requires bank account ID — skipping)"
echo "   Run manually: freeagent_run_reconciliation({bankAccountId: \"YOUR_ID\", dryRun: true})"
SKIP=$((SKIP + 1))

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "==================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

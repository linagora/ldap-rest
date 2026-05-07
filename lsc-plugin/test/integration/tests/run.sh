#!/usr/bin/env bash
# Integration test orchestrator for the lsc-ldaprest-plugin.
# Spins the docker-compose stack, runs LSC, asserts the expected state via
# both the ldap-rest API and direct ldapsearch on the target, then tears
# everything down (even on failure).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE="docker compose -f $ROOT/docker-compose.yml"
TOKEN="lsc-it-token-please-change-me-32chars"
REST_HOST="http://localhost:18081"

PASS=0
FAIL=0

log()  { echo "[run.sh] $*" >&2; }
pass() { echo "  PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

cleanup() {
    log "dumping container logs to $ROOT/logs/"
    mkdir -p "$ROOT/logs"
    for svc in ldap-source ldap-target ldap-rest lsc; do
        $COMPOSE logs --no-color "$svc" > "$ROOT/logs/$svc.log" 2>&1 || true
    done
    log "tearing down stack"
    $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "building images and starting backing services"
$COMPOSE up -d --build ldap-source ldap-target ldap-rest

log "waiting for healthchecks"
for i in $(seq 1 60); do
    if $COMPOSE ps --format json 2>/dev/null | grep -q '"Health":"healthy"'; then
        if [ "$($COMPOSE ps --status running --format '{{.Service}}' | sort -u | wc -l)" -ge 3 ]; then
            break
        fi
    fi
    sleep 2
done

log "starting lsc container"
$COMPOSE up -d --build lsc

# Helper: GET via ldap-rest with bearer auth
rest_get() {
    curl -s -o /tmp/rest-body -w '%{http_code}' \
        -H "Authorization: Bearer $TOKEN" \
        "$REST_HOST$1"
}

source "$HERE/assertions.sh"

log "scenario 1: initial CREATE"
$COMPOSE exec -T -e LDAP_REST_TOKEN=$TOKEN lsc lsc -f /etc/lsc -s users-task -t users-task >/tmp/lsc-1.log 2>&1 \
    || { cat /tmp/lsc-1.log; fail "lsc run 1 failed"; }
assert_users_created

log "scenario 2: UPDATE — modify alice's mail in source, re-sync"
$COMPOSE exec -T ldap-source bash -c "ldapmodify -x -D 'cn=admin,dc=source,dc=example,dc=com' -w admin <<EOF
dn: uid=alice,ou=users,dc=source,dc=example,dc=com
changetype: modify
replace: mail
mail: alice.updated@source.example.com
EOF" >/dev/null
$COMPOSE exec -T -e LDAP_REST_TOKEN=$TOKEN lsc lsc -f /etc/lsc -s users-task -t users-task >/tmp/lsc-2.log 2>&1 \
    || { cat /tmp/lsc-2.log; fail "lsc run 2 failed"; }
assert_alice_mail_updated

log "scenario 3: DELETE — remove eve from source, re-sync"
$COMPOSE exec -T ldap-source ldapdelete -x -D 'cn=admin,dc=source,dc=example,dc=com' -w admin \
    'uid=eve,ou=users,dc=source,dc=example,dc=com' >/dev/null
$COMPOSE exec -T -e LDAP_REST_TOKEN=$TOKEN lsc lsc -f /etc/lsc -s users-task -t users-task >/tmp/lsc-3.log 2>&1 \
    || { cat /tmp/lsc-3.log; fail "lsc run 3 failed"; }
assert_eve_deleted

echo ""
echo "================================="
echo "Results: $PASS passed, $FAIL failed"
echo "================================="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi

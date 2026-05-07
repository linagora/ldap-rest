# Shared assertions sourced by run.sh. Increments $PASS / $FAIL via pass/fail.

assert_users_created() {
    log "  asserting 5 users exist in ldap-rest"
    code=$(rest_get "/api/v1/ldap/users")
    if [ "$code" = "200" ]; then
        n=$(jq '. | length' /tmp/rest-body 2>/dev/null || echo 0)
        if [ "$n" = "5" ]; then
            pass "ldap-rest GET /users returns 5 entries"
        else
            fail "expected 5 users in ldap-rest, got $n"
        fi
    else
        fail "ldap-rest GET /users returned $code"
    fi

    log "  asserting alice exists with correct attrs in ldap-rest"
    code=$(rest_get "/api/v1/ldap/users/alice")
    if [ "$code" = "200" ] && jq -e '.uid == "alice" and .mail == "alice@source.example.com"' /tmp/rest-body >/dev/null; then
        pass "alice present with expected mail"
    else
        fail "alice not found or mail mismatch (code=$code)"
    fi

    log "  asserting alice is reachable via direct ldapsearch on target"
    if $COMPOSE exec -T ldap-target ldapsearch -x -LLL -H ldap://localhost \
        -D 'cn=admin,dc=target,dc=example,dc=com' -w admin \
        -b 'ou=users,dc=target,dc=example,dc=com' \
        '(uid=alice)' uid mail 2>/dev/null | grep -q '^uid: alice$'; then
        pass "alice reachable via ldapsearch on target (proves ldap-rest wrote LDAP, not just acked)"
    else
        fail "alice not found via direct ldapsearch — ldap-rest may have acked without writing"
    fi
}

assert_alice_mail_updated() {
    log "  asserting alice's mail was updated"
    code=$(rest_get "/api/v1/ldap/users/alice")
    if [ "$code" = "200" ] && jq -e '.mail == "alice.updated@source.example.com"' /tmp/rest-body >/dev/null; then
        pass "alice mail updated to alice.updated@source.example.com"
    else
        actual=$(jq -r '.mail // "<missing>"' /tmp/rest-body 2>/dev/null || echo "<error>")
        fail "alice mail not updated (got: $actual)"
    fi
}

assert_eve_deleted() {
    log "  asserting eve was deleted"
    code=$(rest_get "/api/v1/ldap/users/eve")
    if [ "$code" = "404" ]; then
        pass "eve deleted (ldap-rest returns 404)"
    else
        fail "eve not deleted (ldap-rest returned $code)"
    fi
}

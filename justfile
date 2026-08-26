# pi-cc — pre-commit gate is `just check`

# pre-commit gate: lint + types + unit tests
check:
    npm run check

# full suite including live integration tests
test:
    npm test

# lint only
lint:
    npm run lint

# typecheck only
typecheck:
    npm run typecheck

# unit tests only
test-unit:
    npm run test:unit

# auto-format
fmt:
    npm run format

# pre-ship probe: static/unit gate + bridge-only smoke
verify: check
    tests/int-smoke.sh

# ship: verify → push → deploy to pi
ship: verify
    git push
    pi update git:github.com/iteebz/pi-cc

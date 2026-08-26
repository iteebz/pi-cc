# pi-cc-bridge — pre-commit gate is `just check`

# pre-commit gate: lint + types + unit tests
check:
    pnpm run check

# full suite including live integration tests
test:
    pnpm test

# lint only
lint:
    pnpm run lint

# typecheck only
typecheck:
    pnpm run typecheck

# unit tests only
test-unit:
    pnpm run test:unit

# auto-format
fmt:
    pnpm run format

# ship: check → push → deploy to pi
ship: check
    git push
    pi update git:github.com/iteebz/pi-cc-bridge

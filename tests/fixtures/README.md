# Fixture ownership

Fixture source generators live in `../support/source-fixture.mjs` and
`../support/configure.mjs`. Runtime keys and synthetic accounts are generated
into project-owned named volumes; none are supplied in this directory.

The consumer AiaB fixture definitions and examples remain in
`../atmosphere/`. They are source inputs, not saved runtime state.

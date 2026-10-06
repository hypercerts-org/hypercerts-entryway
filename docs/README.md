# Project design and delivery documents

These documents capture the Entryway architecture, implementation context and
recorded technical evidence. Linear owns delivery planning and acceptance criteria.
They distinguish reusable spike code, proposed behaviour and unresolved release requirements.
This repository is self-contained: use the source, harness, documentation and
baseline records here. Project-specific acceptance matrices live in [Linear](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71), referenced from the repository’s test plans. Public design/source references do not require a sibling
checkout. The [test-plan index](../tests/plans/README.md) links the baseline and the maintained Linear inventory of source provenance and unresolved cases.

| Document | Contents |
| --- | --- |
| [Architecture](architecture.md) | System overview, vertical feature ownership, three port boundaries, source layout, login sequence and fleet lifecycle |
| [Delivery planning](delivery-plan.md) | Links to the maintained Linear project and document |
| [Terminology](glossary.md) | Shared vocabulary and protocol references |
| [Implementation assessment](implementation-assessment.md) | Source-grounded database, coordination and resilience gaps |
| [Evidence](evidence/README.md) | Retained baseline, verification and source-parity receipts |
| [Data model and custody](data-custody.md) | DID-based account model, provider boundaries, key custody, transfer cases and observed test migration order |
| [Reuse assessment](reuse-assessment.md) | Reusable code, required implementation and investigation findings |
| [Testing](testing.md) | Local Atmosphere in a Box commands, repeatable flows and evidence limits |
| [Database configuration](database.md) | Drizzle adapters, deployment selection, transactions and verified single-node profiles |
| [Source mapping](source-map.json) | Original spike modules, imported locations and current ownership |

## Diagram conventions

Process flowcharts run horizontally (`flowchart LR`); sequence diagrams retain
their normal time axis. Mermaid diagrams use pastel fills, dark text, dark outlines and labeled connectors.
Blue identifies clients or inputs; violet identifies Entryway policy; green identifies data or hosting;
peach identifies external authority or a decision-sensitive transition.
Text labels carry the meaning so readers do not need to distinguish colors.

Diagrams show target responsibilities unless their heading explicitly identifies current test behaviour.
Dashed adapter arrows mean implementation of a port. Other arrows are labeled with their interaction.
The data diagram is a logical model; it does not claim all entities have new normalized SQL tables.

Use a Markdown viewer with Mermaid support. Renderer versions can change layout and spacing.
The documents contain Mermaid source, not exported images or a new Lexidraw scene.

## Core design references

- [Original architecture: Trust Territories](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mvrtfvnwu32i).
- [Original login flow: A Journey](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mvrthkln3t2i).
- [Better Auth integration](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mvrtiqigo32i).
- [Layered OAuth Provider: Cross-Section](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mvrtkdnr732i).
- [Spike architecture, data model and custody](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mwlv6d5ddp23).

Use the [glossary](glossary.md) for terminology and supporting ATProto documentation. The diagrams describe design; current acceptance reports establish what works.

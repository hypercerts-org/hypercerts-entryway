# Project design and delivery documents

These documents capture the mini Entryway architecture and six-week delivery proposal agreed in this session.
They distinguish reusable spike code, proposed behaviour and unresolved release requirements.

| Document | Contents |
| --- | --- |
| [Architecture](architecture.md) | System overview, vertical feature ownership, three port boundaries, source layout, login sequence and fleet lifecycle |
| [Project plan](delivery-plan.md) | Glossary, six milestones, acceptance criteria, two-person ownership and check-ins |
| [Data model and custody](data-custody.md) | DID-based account model, provider boundaries, key custody, transfer cases and observed test migration order |
| [Reuse assessment](reuse-assessment.md) | Reusable code, required implementation and investigation findings |
| [Testing](testing.md) | Local Atmosphere in a Box commands, repeatable flows and evidence limits |
| [Source mapping](source-map.json) | Original spike modules, imported locations and current ownership |

## Diagram conventions

Mermaid diagrams use pastel fills, dark text, dark outlines and labeled connectors.
Blue identifies clients or inputs; violet identifies Entryway policy; green identifies data or hosting;
peach identifies external authority or a decision-sensitive transition.
Text labels carry the meaning so readers do not need to distinguish colors.

Diagrams show target responsibilities unless their heading explicitly identifies current test behaviour.
Dashed adapter arrows mean implementation of a port. Other arrows are labeled with their interaction.
The data diagram is a logical model; it does not claim all entities have new normalized SQL tables.

Use a Markdown viewer with Mermaid support. Renderer versions can change layout and spacing.
The documents contain Mermaid source, not exported images or a new Lexidraw scene.

## Core design references

- [Entryway architecture and authorization flows](https://lexidraw.app/s/kandake.africa/3mvrtiqigo32i).
- [Spike architecture, data model and custody](https://lexidraw.app/s/did%3Aplc%3Alrphxvv25aibthe7xoc2eeyy/3mwlv6d5ddp23).

Use the project plan for the glossary and supporting ATProto documentation. The diagrams describe design; current acceptance reports establish what works.

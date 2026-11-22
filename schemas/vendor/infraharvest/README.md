# Vendored schemas

`graph-v1.schema.json` is infraharvest's `graph/v1` document, copied unchanged from
`schemas/graph-v1.schema.json` of the infraharvest repository at commit `a51f6e9b`
(`feat(export): graph/v1, the imported resources and the references between them`).
It is Apache-2.0, like the schemas Terragram publishes itself.

`terragram graph` and `terragram-engine/graph` read documents written against it. The
zod schema in `packages/engine/src/graph/schema.ts` mirrors it, and
`tests/graph.test.ts` validates the same documents against both. To update, copy the
new file over this one and change the commit above.

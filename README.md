# @lobomfz/elysia-trpc

A plugin for [elysia](https://github.com/elysiajs/elysia) that adds support for using tRPC, integrated with [trpc-docgen](https://github.com/lobomfz/trpc-docgen).

## Notes:
- The OpenAPI router removes tRPC's weird body input, so it accepts exactly what the procedure schema expects. 
- This requires a patched version of tRPC, see [this PR](https://github.com/trpc/trpc/pull/5909).


## Installation

```bash
bun add @lobomfz/elysia-trpc
```

## Example

```typescript
import { initTRPC } from "@trpc/server";
import { generateTrpcDocs, type OpenApiMeta } from "@lobomfz/trpc-docgen";
import { Type } from "@sinclair/typebox";
import Elysia from "elysia";
import { trpc } from "../src";

// this meta optional, but highly recommended
const t = initTRPC.meta<OpenApiMeta>().create();

const router = t.router;

const appRouter = router({
	createDate: t.procedure
		.input(
			Type.Object({
				date: Type.String(),
			}),
		)
		.mutation(({ input }) => ({
			date: input.date,
		})),
});

```
## You can integrate with [trpc-docgen](https://github.com/lobomfz/trpc-docgen) to serve your restful OpenAPI router

```ts
const { mappings } = await generateTrpcDocs(appRouter, {
	baseUrl: "http://localhost:3000",
	title: "My API",
	version: "1.0.0",
});

new Elysia()
	.use(
		trpc(appRouter, {
			endpoint: "/trpc",
		}),
	)
	.use(
		trpc(appRouter, {
			endpoint: "/openapi",
			openApi: {
				// in this example, createDate will be mapped to a POST /trpc/date
				mappings,
				trpcEndpoint: "/trpc",
			},
		}),
	).listen(3000);
```


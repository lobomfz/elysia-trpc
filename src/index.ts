import { type Elysia, getSchemaValidator } from "elysia";

import {
	type AnyTRPCRouter,
	TRPCError,
	callTRPCProcedure,
	getErrorShape,
} from "@trpc/server";
import { type Unsubscribable, isObservable } from "@trpc/server/observable";
import type { TSchema } from "@sinclair/typebox";
import {
	type JSONRPC2,
	type TRPCClientOutgoingMessage,
	type TRPCResponseMessage,
	type inferRouterContext,
	parseTRPCMessage,
	transformTRPCResponse,
} from "@trpc/server/unstable-core-do-not-import";
import type { ServerWebSocket } from "bun";
import { fetchRequestHandler } from "./handler";
import type { TRPCOptions } from "./types";
import { getTRPCErrorFromUnknown } from "./utils";

export function compile<T extends TSchema>(schema: T) {
	const check = getSchemaValidator(schema, {});
	if (!check) throw new Error("Invalid schema");

	return (value: unknown) => {
		if (check.Check(value)) return value;

		const { path, message } = [...check.Errors(value)][0];

		throw new TRPCError({
			message: `${message} for ${path}`,
			code: "BAD_REQUEST",
		});
	};
}

const getPath = (url: string) => {
	const start = url.indexOf("/", 9);
	const end = url.indexOf("?", start);

	if (end === -1) return url.slice(start);

	return url.slice(start, end);
};

export const trpc =
	<
		TRouter extends AnyTRPCRouter,
		tRPCSocket extends ServerWebSocket<{
			ctx: inferRouterContext<TRouter> | undefined;
			request: Request;
			subscriptions: Map<number | string, Unsubscribable>;
		}>
	>(
		router: AnyTRPCRouter,
		{ endpoint = "/trpc", ...options }: TRPCOptions = {
			endpoint: "/trpc",
		}
	) =>
	(eri: Elysia) => {
		const app = eri
			// filter only trpc requests
			.onParse({ as: "global" }, ({ request: { url } }) => {
				const path = getPath(url);

				if (!path.startsWith(endpoint)) return true;
			})
			// re-route get and post requests to fetchRequestHandler
			.get(`${endpoint}/*`, ({ request }) => {
				const path = getPath(request.url).split(endpoint)[1];

				// if its a mapped path (openAPI), replace it with its trpc equivalent
				const mappedPath = options.openApi?.mappings[path];

				const url = mappedPath
					? request.url
							.replace(path, `/${mappedPath}`)
							.replace(endpoint, options.openApi!.trpcEndpoint)
					: undefined;

				return fetchRequestHandler(
					{
						...options,
						req: request,
						router,
						endpoint,
					},
					url
				);
			})
			.post(`${endpoint}/*`, async ({ request }) => {
				const path = getPath(request.url).split(endpoint)[1];

				const mappedPath = options.openApi?.mappings[path];

				const url = mappedPath
					? request.url
							.replace(path, `/${mappedPath}`)
							.replace(endpoint, options.openApi!.trpcEndpoint)
					: undefined;

				// add { json: } to body
				if (url) {
					const parsedBody = await request.json();

					const newBody = {
						json: parsedBody,
					};

					const newRequest = new Request(request.url, {
						method: request.method,
						headers: request.headers,
						body: new ReadableStream({
							start(controller) {
								controller.enqueue(JSON.stringify(newBody));
								controller.close();
							},
						}),
					});

					return fetchRequestHandler(
						{
							...options,
							req: newRequest,
							router,
							endpoint,
						},
						url
					);
				}

				return fetchRequestHandler(
					{
						...options,
						req: request,
						router,
						endpoint,
					},
					url
				);
			});

		// subscriptions section
		if (app.ws) {
			function respond(
				ws: tRPCSocket,
				untransformedJSON: TRPCResponseMessage
			) {
				ws.send(
					JSON.stringify(
						transformTRPCResponse(
							router._def._config,
							untransformedJSON
						)
					)
				);
			}

			app.ws<any, any, any>(endpoint, {
				async open(ws: any) {
					ws.data.subscriptions = new Map<
						number | string,
						Unsubscribable
					>();

					const { createContext } = options;
					const { request: req } = ws.data;

					const ctx: inferRouterContext<TRouter> | undefined =
						undefined;
					const ctxPromise = createContext?.({
						req,
					} as any);

					async function createContextAsync() {
						try {
							ws.data.ctx = await ctxPromise;
						} catch (cause) {
							const error = getTRPCErrorFromUnknown(cause);
							options.onError?.({
								error,
								path: undefined,
								type: "unknown",
								ctx,
								req,
								input: undefined,
							});
							respond(ws, {
								id: null,
								error: getErrorShape({
									config: router._def._config,
									error,
									type: "unknown",
									path: undefined,
									input: undefined,
									ctx,
								}),
							});

							// close in next tick
							(global.setImmediate ?? global.setTimeout)(() => {
								ws.close();
							});
						}
					}
					await createContextAsync();
				},
				async message(ws: tRPCSocket, message: any) {
					const { transformer } = router._def._config;
					const { request: req, ctx, subscriptions } = ws.data;

					function stopSubscription(
						subscription: Unsubscribable,
						{
							id,
							jsonrpc,
						}: JSONRPC2.BaseEnvelope & { id: JSONRPC2.RequestId }
					) {
						subscription.unsubscribe();

						respond(ws, {
							id,
							jsonrpc,
							result: {
								type: "stopped",
							},
						});
					}

					async function handleRequest(
						msg: TRPCClientOutgoingMessage
					) {
						const { id, jsonrpc } = msg;
						if (id === null) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: "`id` is required",
							});
						}

						if (msg.method === "subscription.stop") {
							const sub = subscriptions.get(id);

							if (sub) {
								stopSubscription(sub, { id, jsonrpc });
							}
							subscriptions.delete(id);
							return;
						}

						const { path, input } = msg.params;
						const type = msg.method;
						try {
							const result = await callTRPCProcedure({
								procedures: router._def.procedures,
								path,
								getRawInput: async () => input,
								ctx,
								type,
							});

							if (type === "subscription") {
								if (!isObservable(result)) {
									throw new TRPCError({
										message: `Subscription ${path} did not return an observable`,
										code: "INTERNAL_SERVER_ERROR",
									});
								}
							} else {
								return void respond(ws, {
									id,
									jsonrpc,
									result: {
										type: "data",
										data: result,
									},
								});
							}

							const observable = result;
							const sub = observable.subscribe({
								next(data) {
									respond(ws, {
										id,
										jsonrpc,
										result: {
											type: "data",
											data,
										},
									});
								},
								error(err) {
									const error = getTRPCErrorFromUnknown(err);
									options.onError?.({
										error,
										path,
										type,
										ctx,
										req,
										input,
									});
									respond(ws, {
										id,
										jsonrpc,
										error: getErrorShape({
											config: router._def._config,
											error,
											type,
											path,
											input,
											ctx,
										}),
									});
								},
								complete() {
									respond(ws, {
										id,
										jsonrpc,
										result: {
											type: "stopped",
										},
									});
								},
							});

							if ((ws as any).raw.readyState !== WebSocket.OPEN) {
								// if the client got disconnected whilst initializing the subscription
								// no need to send stopped message if the client is disconnected
								sub.unsubscribe();
								return;
							}

							if (subscriptions.has(id)) {
								stopSubscription(sub, { id, jsonrpc });
								throw new TRPCError({
									message: `Duplicate id ${id}`,
									code: "BAD_REQUEST",
								});
							}
							subscriptions.set(id, sub);

							respond(ws, {
								id,
								jsonrpc,
								result: {
									type: "started",
								},
							});
						} catch (cause) {
							const error = getTRPCErrorFromUnknown(cause);
							options.onError?.({
								error,
								path,
								type,
								ctx,
								req,
								input,
							});
							respond(ws, {
								id,
								jsonrpc,
								error: getErrorShape({
									config: router._def._config,
									error,
									type,
									path,
									input,
									ctx,
								}),
							});
						}
					}

					try {
						const msgJSON: unknown =
							typeof message === "object"
								? message
								: JSON.parse(message.toString());
						const msgs: unknown[] = Array.isArray(msgJSON)
							? msgJSON
							: [msgJSON];
						const promises = msgs
							.map((raw) => parseTRPCMessage(raw, transformer))
							.map(handleRequest);
						await Promise.all(promises);
					} catch (cause) {
						const error = new TRPCError({
							code: "PARSE_ERROR",
							cause,
						});

						return void respond(ws, {
							id: null,
							error: getErrorShape({
								config: router._def._config,
								error,
								type: "unknown",
								path: undefined,
								input: undefined,
								ctx: undefined,
							}),
						});
					}
				},
				close(ws: tRPCSocket) {
					for (const sub of ws.data.subscriptions.values()) {
						sub.unsubscribe();
					}
					ws.data.subscriptions.clear();
				},
			});
		}

		return app;
	};

export type { TRPCClientIncomingRequest, TRPCOptions } from "./types";

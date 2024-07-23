import type { AnyTRPCRouter } from "@trpc/server";
import type { FetchHandlerRequestOptions } from "@trpc/server/adapters/fetch";
import { resolveResponse, toURL } from "@trpc/server/http";

const trimSlashes = (path: string): string => {
	path = path.startsWith("/") ? path.slice(1) : path;
	path = path.endsWith("/") ? path.slice(0, -1) : path;

	return path;
};

// borrowed from @trpc/server, needs some refactoring
export async function fetchRequestHandler<TRouter extends AnyTRPCRouter>(
	opts: FetchHandlerRequestOptions<TRouter>,
	customUrl?: string,
): Promise<Response> {
	const resHeaders = new Headers();

	const createContext: any = (innerOpts: any) => {
		return opts.createContext?.({
			req: opts.req,
			resHeaders,
			...innerOpts,
		});
	};

	const url = toURL(customUrl ?? opts.req.url);

	const pathname = trimSlashes(url.pathname);
	const endpoint = trimSlashes(opts.endpoint);
	const path = trimSlashes(pathname.slice(endpoint.length));

	return await resolveResponse({
		...opts,
		req: opts.req,
		createContext,
		path,
		error: null,
		onError(o) {
			opts?.onError?.({ ...o, req: opts.req });
		},
		responseMeta(data) {
			const meta = opts.responseMeta?.(data);

			if (meta?.headers) {
				for (const [key, value] of (meta.headers as any).entries()) {
					resHeaders.append(key, value);
				}
			}

			return {
				headers: resHeaders,
				status: meta?.status,
			};
		},
	});
}

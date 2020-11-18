import fs from 'fs';
import path from 'path';
import mime from 'mime/lite';
import { Handler, SapperRequest, SapperResponse, SapperNext, build_dir, dev, manifest } from '@sapper/internal/manifest-server';
import { get_server_route_handler } from './get_server_route_handler';
import { get_page_handler } from './get_page_handler';

type IgnoreValue = IgnoreValue[] | RegExp | ((uri: string) => boolean) | string;

export default function middleware(opts: {
	session?: (req: SapperRequest, res: SapperResponse) => any,
	ignore?: IgnoreValue,
    catchErrors?: boolean
} = {}) {
	const { session, ignore, catchErrors = true } = opts;

	let emitted_basepath = false;

	return compose_handlers(ignore, [
		(req: SapperRequest, res: SapperResponse, next: () => void) => {
			if (req.baseUrl === undefined) {
				let originalUrl = req.originalUrl || req.url;
				if (req.url === '/' && originalUrl[originalUrl.length - 1] !== '/') {
					originalUrl += '/';
				}

				req.baseUrl = originalUrl
					? originalUrl.slice(0, -req.url.length)
					: '';
			}

			if (!emitted_basepath && process.send) {
				process.send({
					__sapper__: true,
					event: 'basepath',
					basepath: req.baseUrl
				});

				emitted_basepath = true;
			}

			if (req.path === undefined) {
				req.path = req.url.replace(/\?.*/, '');
			}

			next();
		},

		fs.existsSync(path.join(build_dir, 'service-worker.js')) && serve({
			pathname: '/service-worker.js',
			cache_control: 'no-cache, no-store, must-revalidate'
		}),

		fs.existsSync(path.join(build_dir, 'service-worker.js.map')) && serve({
			pathname: '/service-worker.js.map',
			cache_control: 'no-cache, no-store, must-revalidate'
		}),

		serve({
			prefix: '/client/',
			cache_control: dev ? 'no-cache' : 'max-age=31536000, immutable'
		}),

		get_server_route_handler(manifest.server_routes),

		get_page_handler(manifest, session || noop),

		catchErrors ? bail_on_error : null
	].filter(Boolean));
}

export function compose_handlers(ignore: IgnoreValue, handlers: Handler[]): Handler {
	const total = handlers.length;

	function nth_handler(n: number, err: any, req: SapperRequest, res: SapperResponse, next: SapperNext) {
		if (n >= total) {
			return next(err);
		}

		const handler = handlers[n];
		const handler_next: SapperNext = (handler_err) => nth_handler(n+1, handler_err, req, res, next);

		if (handler.length === 4) {
			// handler can handle both error and non-error situations
			handler(err, req, res, handler_next);
		} else if (!err) {
			// no error, can call handler as regular middleware
			handler(req, res, handler_next);
		} else {
			// error but current handler can't do error handling. Skip to next
			handler_next(err);
		}
	}

	return !ignore
		? (req, res, next) => nth_handler(0, null, req, res, next)
		: (req, res, next) => {
			if (should_ignore(req.path, ignore)) {
				next();
			} else {
				nth_handler(0, null, req, res, next);
			}
		};
}

export function should_ignore(uri: string, val: IgnoreValue) {
	if (Array.isArray(val)) return val.some(x => should_ignore(uri, x));
	if (val instanceof RegExp) return val.test(uri);
	if (typeof val === 'function') return val(uri);
	return uri.startsWith(val.charCodeAt(0) === 47 ? val : `/${val}`);
}

export function serve({ prefix, pathname, cache_control }: {
	prefix?: string,
	pathname?: string,
	cache_control: string
}): Handler {
	const filter = pathname
		? (req: SapperRequest) => req.path === pathname
		: (req: SapperRequest) => req.path.startsWith(prefix);

	const cache: Map<string, Buffer> = new Map();

	const read = dev
		? (file: string) => fs.readFileSync(path.join(build_dir, file))
		: (file: string) => (cache.has(file) ? cache : cache.set(file, fs.readFileSync(path.join(build_dir, file)))).get(file);

	return (req: SapperRequest, res: SapperResponse, next: SapperNext) => {
		if (filter(req)) {
			const type = mime.getType(req.path);

			try {
				const file = path.posix.normalize(decodeURIComponent(req.path));
				const data = read(file);

				res.setHeader('Content-Type', type);
				res.setHeader('Cache-Control', cache_control);
				res.end(data);
			} catch (err) {
				if (err.code === 'ENOENT') {
					next();
				} else {
					next(err);
				}
			}
		} else {
			next();
		}
	};
}

async function noop() {}

function bail_on_error(err: any, req: SapperRequest, res: SapperResponse, next: SapperNext) {
	console.error(err);

	if (!err || res.headersSent) {
		return;
	}

	const message = dev ? escape_html(err?.toString() || '') : 'Internal server error';

	res.statusCode = 500;
	res.end(`<pre>${message}</pre>`);
}

function escape_html(html: string) {
	const chars: Record<string, string> = {
		'"' : 'quot',
		'\'': '#39',
		'&': 'amp',
		'<' : 'lt',
		'>' : 'gt'
	};

	return html.replace(/["'&<>]/g, c => `&${chars[c]};`);
}

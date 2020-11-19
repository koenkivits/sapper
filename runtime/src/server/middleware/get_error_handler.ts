import { sourcemap_stacktrace } from './sourcemap_stacktrace';
import {
	Manifest,
	SapperRequest,
	SapperResponse,
	SapperNext,
	Handler,
	dev
} from '@sapper/internal/manifest-server';
import { PageRenderer } from './get_page_renderer';

export function get_error_handler(
	manifest: Manifest,
	page_renderer: PageRenderer
): Handler {
	const { error_handler, error: error_route } = manifest;

    function render_plain(err, req, res) {
        if (!dev) {
            if (res.statusCode === 404) {
                return res.end('Not found');
            } else {
                return res.end('Internal server error');
            }
        }

        let errText = err.toString();
        if (err.stack) {
            errText += `\n${err.stack}`;
        }

        const contentType = res.getHeader('Content-Type');
        const sendsHtml = (
            !contentType ||
            contentType.toLowerCase().includes('text/html')
        );
        const needsHtml = (sendsHtml && res.headersSent);

        if (needsHtml) {
            errText = escape_html(errText);
        } else {
            res.setHeader('Content-Type', 'text/plain');
        }

        res.end(errText);
    }

    function render_page(err, req, res) {
		return page_renderer({
			pattern: null,
			parts: [
				{ name: null, component: { default: error_route } }
			]
		}, req, res, err);
    }

	return async function handle_error(err: any, req: SapperRequest, res: SapperResponse, next: SapperNext) {
		err = err || 'Unknown error';

        /*
        const handle_next = (err?: any) => {
            process.nextTick(() => next?.(err));
        };*/

        if (err instanceof Error && err.stack) {
            err.stack = sourcemap_stacktrace(err.stack);
        }

        console.error(err);

        res.statusCode = err.status ?? err.statusCode ?? 500;

        try {
            await render_page(err, req, res);
        } catch (renderErr) {
            await render_plain(err, req, res);
        }
	};
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

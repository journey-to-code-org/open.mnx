<?php

namespace Zubra\Laravel;

use Closure;
use Zubra\Deferred;
use Zubra\Page;

/**
 * Marks the request so `@zubraHead` and `@zubraScripts` leave markers, then puts the page's CSS
 * and modules there once the response is rendered: a layout's `<head>` is written before the
 * view's components are.
 */
class Middleware
{
    public function __construct(private Page $page)
    {
    }

    public function handle($request, Closure $next)
    {
        $request->attributes->set('zubra.deferred', true);
        $token = Deferred::token();
        $request->attributes->set('zubra.marker', $token);
        $response = $next($request);
        $type = (string) $response->headers->get('Content-Type', '');
        if (!method_exists($response, 'getContent') || ($type !== '' && !str_contains($type, 'html'))) {
            return $response;
        }
        $content = $response->getContent();
        if (is_string($content) && $content !== '') {
            $response->setContent($this->page->fill($content, $token));
        }
        return $response;
    }
}

<?php

namespace Zubra;

/**
 * Markers a layout's head and scripts leave when the page's CSS and modules are filled in after
 * rendering (a layout's `<head>` is written before the view's components are). Each carries the
 * request's own random token, so text in the page (a user's comment containing a marker) is never
 * taken for one and filled with a script.
 */
final class Deferred
{
    /** A token for one request's markers. */
    public static function token(): string
    {
        return bin2hex(random_bytes(12));
    }

    public static function head(string $token): string
    {
        return "<!--zubra:head:$token-->";
    }

    /** What each scripts marker for `$token` starts with; the base follows, then `-->`. */
    public static function scriptsPrefix(string $token): string
    {
        return "<!--zubra:scripts:$token:";
    }

    public static function scripts(string $token, string $base): string
    {
        return self::scriptsPrefix($token) . str_replace('--', '', $base) . '-->';
    }
}

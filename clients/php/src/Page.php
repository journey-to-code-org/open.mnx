<?php

namespace Zubra;

/** What one page rendered, so its layout can add those components' CSS and modules. */
class Page
{
    /** @var string[] */
    public array $modules = [];

    public function __construct(public readonly Zubra $zubra)
    {
    }

    public function render(string $name, array $props = [], array $slots = []): string
    {
        $html = $this->zubra->html($name, $props, $slots);
        if (!in_array($name, $this->modules, true)) {
            $this->modules[] = $name;
        }
        return $html;
    }

    /** The CSS of every component the page rendered (and what they import). */
    public function styles(): string
    {
        return implode("\n", array_map(fn ($name) => $this->zubra->css($name), $this->modules));
    }

    /** `<style data-zb-components>…</style>`, for the layout's `<head>`; empty if nothing rendered. */
    public function head(): string
    {
        return $this->modules ? '<style data-zb-components>' . $this->styles() . '</style>' : '';
    }

    /** The `<script type="module">` that loads each rendered component from `$base<name>.js`; empty if nothing rendered. */
    public function scripts(string $base = '/components/'): string
    {
        if (!$this->modules) {
            return '';
        }
        $imports = '';
        foreach ($this->modules as $name) {
            $imports .= "    import '" . htmlspecialchars($base, ENT_QUOTES) . "$name.js';\n";
        }
        return "<script type=\"module\">\n$imports  </script>";
    }

    /** Put this page's CSS and modules where the head and scripts markers with `$token` are (see Deferred). */
    public function fill(string $html, string $token): string
    {
        $html = str_replace(Deferred::head($token), $this->head(), $html);
        $prefix = Deferred::scriptsPrefix($token);
        $at = 0;
        while (($start = strpos($html, $prefix, $at)) !== false) {
            $end = strpos($html, '-->', $start);
            $base = substr($html, $start + strlen($prefix), $end - $start - strlen($prefix));
            $filled = $this->scripts($base);
            $html = substr($html, 0, $start) . $filled . substr($html, $end + 3);
            $at = $start + strlen($filled);
        }
        return $html;
    }
}

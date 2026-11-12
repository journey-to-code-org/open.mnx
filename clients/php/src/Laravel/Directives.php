<?php

namespace Zubra\Laravel;

/** What the Blade directives compile to. */
final class Directives
{
    /** @return array<string, callable(string): string> */
    public static function all(): array
    {
        return [
            'zubra' => fn (string $expression) => "<?php echo \\Zubra\\Laravel\\Helpers::render($expression); ?>",
            'zubraHead' => fn () => '<?php echo \\Zubra\\Laravel\\Helpers::head(); ?>',
            'zubraScripts' => fn (string $expression = '') => '<?php echo \\Zubra\\Laravel\\Helpers::scripts(' . ($expression === '' ? '' : $expression) . '); ?>',
        ];
    }
}

<?php

namespace Zubra\Laravel;

use Zubra\Zubra;

/** GET /components/{name}.js: the module that defines a component's element. */
class ModuleController
{
    public function __invoke(Zubra $zubra, string $name)
    {
        abort_unless(in_array($name, $zubra->names(), true), 404);
        return response($zubra->js($name), 200, ['Content-Type' => 'text/javascript; charset=utf-8']);
    }
}

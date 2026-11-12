# zubra for Ruby

Render [Zubra](https://github.com/journey-to-code-org/zubra) web components from Rails, Sinatra, or any Ruby server, with no Node.js anywhere. The components are compiled by the Zubra compiler (a Rust binary) running as one long-lived `zubra serve` process; the browser hydrates the HTML your server wrote.

It isn't on RubyGems yet. Install it from the repository, and put a compiler where it can find it (see "Finding the compiler"):

```ruby
# Gemfile
gem "zubra", github: "journey-to-code-org/zubra", glob: "clients/ruby/*.gemspec"
```

```ruby
require "zubra"

zubra = Zubra.new("components")                  # a folder of .zb files
page = zubra.page                                # one per request
html = page.render("price-tag", amount: 12)      # server-rendered HTML
page.head                                        # <style data-zb-components>…</style>, for <head>
page.scripts                                     # <script type="module">…</script>, before </body>
```

Serve `zubra.js(name)` at `/components/<name>.js` and `@zubra/runtime`'s ES modules (from the npm package) wherever your import map points; the page works without them, and they make it interactive.

## Rails

```ruby
require "zubra/rails"                            # in config/application.rb, after Bundler.require
config.zubra.components = "app/components"       # the default
# config/routes.rb
mount Zubra::Rails::Modules.new, at: "/components"
```

```erb
<%= zubra "plot-map", plots: @plots, columns: 4 %>   <%# in a view %>
<%= zubra_head %>                                    <%# in the layout's <head> %>
<%= zubra_scripts %>                                 <%# before </body> %>
```

The Railtie adds a middleware that gives each request its own page and fills in `zubra_head` and `zubra_scripts` after the response is rendered, so the layout's `<head>` gets the CSS of components the view renders further down. Other Rack apps: `use Zubra::Rails::Middleware, zubra` and include `Zubra::Rails::Helper` where `request` is available.

## Finding the compiler

In order: the `compiler:` argument (`config.zubra.compiler` in Rails), `$ZUBRA_COMPILER`, then `zubra` on the `PATH`. Download a binary from the project's [releases](https://github.com/journey-to-code-org/zubra/releases).

## When the compiler misbehaves

Every failure is a `Zubra::Error`: a component that doesn't compile, a compiler that can't run, one that stops or answers with something that isn't JSON, and a request that takes longer than `timeout` (30 seconds by default; `timeout: nil` waits). After any of the last three the compiler process is replaced, so a later request can never be handed an earlier one's answer.

## Tests

```sh
ruby -Ilib -Itest test/test_zubra.rb      # against $ZUBRA_COMPILER, or the repository's cargo build
```

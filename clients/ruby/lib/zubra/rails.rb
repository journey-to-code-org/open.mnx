# frozen_string_literal: true

# Rails (and any Rack app): view helpers, a middleware that gives each request its own page, and
# a Rack endpoint for the modules.
#
#   # Gemfile: gem "zubra", github: "journey-to-code-org/zubra", glob: "clients/ruby/*.gemspec"
#   # config/application.rb (the defaults shown):
#   config.zubra.components = "app/components"
#   # config/routes.rb: the modules that make the components interactive
#   mount Zubra::Rails::Modules.new, at: "/components"
#
#   <%= zubra "plot-map", plots: @plots, columns: 4 %>   in a view
#   <%= zubra_head %>                                    in the layout's <head>
#   <%= zubra_scripts %>                                 before </body>
#
# With the middleware (the Railtie adds it), `zubra_head` and `zubra_scripts` leave a marker that
# is filled in once the response is rendered, so the layout's <head> gets the CSS of components
# the view renders later. Without it they render what the page has used so far.
require "zubra"
require "securerandom"

class Zubra
  module Rails
    # The markers carry the request's own random token, so text in the page (a user's comment
    # containing a marker) is never taken for one and filled with a script.
    def self.head_marker(token) = "<!--zubra:head:#{token}-->"
    def self.scripts_marker(token) = "<!--zubra:scripts:#{token}:"

    class << self
      # The app's Zubra (one compiler process for the server).
      attr_accessor :instance
      # Where `zubra_scripts` loads modules from (default "/components/").
      attr_writer :scripts_base

      def scripts_base
        @scripts_base || "/components/"
      end

      def zubra
        instance or raise Zubra::Error, "zubra: no components folder configured (config.zubra.components, or Zubra::Rails.instance = Zubra.new(...))"
      end

      # Put the page's CSS and modules where this request's markers are. The block form of `sub`:
      # a replacement string would read `\\0` or `\\1` in the CSS as back-references.
      def fill(html, page, token)
        html = html.sub(Zubra::Rails.head_marker(token)) { page.head }
        prefix = Zubra::Rails.scripts_marker(token)
        at = 0
        while (start = html.index(prefix, at))
          finish = html.index("-->", start)
          base = html[(start + prefix.length)...finish]
          filled = page.scripts(base)
          html = html[0...start] + filled + html[(finish + 3)..]
          at = start + filled.length
        end
        html
      end
    end

    # View helpers (included into ActionView by the Railtie; anything with `request` can include them).
    module Helper
      def zubra(name, slots: {}, **props)
        safe(zubra_page.render(name, slots: slots, **props))
      end

      def zubra_head
        safe(zubra_deferred? ? Zubra::Rails.head_marker(zubra_marker) : zubra_page.head)
      end

      def zubra_scripts(base = Zubra::Rails.scripts_base)
        safe(zubra_deferred? ? "#{Zubra::Rails.scripts_marker(zubra_marker)}#{base.gsub('--', '')}-->" : zubra_page.scripts(base))
      end

      def zubra_page
        request.env["zubra.page"] ||= Zubra::Rails.zubra.page
      end

      private

      def zubra_deferred?
        request.env["zubra.deferred"] == true
      end

      def zubra_marker
        request.env["zubra.marker"]
      end

      def safe(html)
        html.respond_to?(:html_safe) ? html.html_safe : html
      end
    end

    # Rack middleware: a fresh page per request, and the markers filled in after rendering.
    class Middleware
      def initialize(app, zubra = nil)
        @app = app
        @zubra = zubra
      end

      def call(env)
        page = env["zubra.page"] = (@zubra || Zubra::Rails.zubra).page
        env["zubra.deferred"] = true
        token = env["zubra.marker"] = SecureRandom.hex(12)
        status, headers, body = @app.call(env)
        type = header(headers, "content-type")
        return [status, headers, body] unless type&.include?("html")

        html = +""
        body.each { |chunk| html << chunk }
        body.close if body.respond_to?(:close)
        html = Zubra::Rails.fill(html, page, token)
        set(headers, "content-length", html.bytesize.to_s) if header(headers, "content-length")
        [status, headers, [html]]
      end

      private

      def header(headers, name)
        key = headers.keys.find { |k| k.to_s.downcase == name }
        key && headers[key]
      end

      def set(headers, name, value)
        key = headers.keys.find { |k| k.to_s.downcase == name }
        headers[key] = value
      end
    end

    # A Rack endpoint for the modules: GET <mount>/<name>.js.
    class Modules
      def initialize(zubra = nil)
        @zubra = zubra
      end

      def call(env)
        zubra = @zubra || Zubra::Rails.zubra
        name = env["PATH_INFO"].to_s.delete_prefix("/").delete_suffix(".js")
        return [404, { "content-type" => "text/plain" }, ["no component #{name}"]] unless zubra.names.include?(name)

        [200, { "content-type" => "text/javascript; charset=utf-8" }, [zubra.js(name)]]
      end
    end

    if defined?(::Rails::Railtie)
      class Railtie < ::Rails::Railtie
        config.zubra = ActiveSupport::OrderedOptions.new
        config.zubra.components = "app/components"

        initializer "zubra.setup" do |app|
          Zubra::Rails.instance ||= Zubra.new(app.root.join(app.config.zubra.components), compiler: app.config.zubra.compiler)
          Zubra::Rails.scripts_base = app.config.zubra.scripts_base if app.config.zubra.scripts_base
          app.middleware.use Zubra::Rails::Middleware
          ActiveSupport.on_load(:action_view) { include Zubra::Rails::Helper }
        end
      end
    end
  end
end

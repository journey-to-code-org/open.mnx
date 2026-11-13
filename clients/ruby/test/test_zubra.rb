# frozen_string_literal: true

# The gem against the real compiler: $ZUBRA_COMPILER, or the repository's `cargo build`.
#
#   ruby -Ilib -Itest test/test_zubra.rb
require "minitest/autorun"
require "tmpdir"
require "zubra"
require "zubra/rails"

REPO = File.expand_path("../../..", __dir__)
COMPONENTS = File.join(REPO, "examples/backends/flask-garden/components")
COMPILER = ENV["ZUBRA_COMPILER"] || %w[debug release].map { |b| File.join(REPO, "target", b, "zubra") }.find { |p| File.executable?(p) }

class ZubraTest < Minitest::Test
  def setup
    skip "no compiler: set ZUBRA_COMPILER or cargo build" unless COMPILER
    @zubra = Zubra.new(COMPONENTS, compiler: COMPILER)
  end

  def teardown
    @zubra&.close
  end

  def test_renders_a_component_with_typed_props
    html = @zubra.html("status-pill", { status: "taken", waiting: 2 })
    assert_includes html, "<status-pill"
    assert_includes html, 'data-status="taken"'
    assert_includes html, "2 waiting"
  end

  def test_a_page_collects_css_and_modules
    page = @zubra.page
    assert_equal "", page.head, "nothing rendered: no style"
    assert_equal "", page.scripts
    page.render("status-pill", status: "open")
    page.render("status-pill", status: "taken")
    assert_match(/\A<style data-zb-components>.*\[data-status=open\]/m, page.head)
    assert_equal "<script type=\"module\">\n    import '/static/status-pill.js';\n  </script>", page.scripts("/static/")
  end

  def test_the_module_imports_the_runtime
    assert_includes @zubra.js("status-pill"), 'from "@zubra/runtime"'
    assert_includes @zubra.js("status-pill", runtime: "/vendor/zubra/index.js"), "/vendor/zubra/index.js"
  end

  def test_errors_are_zubra_errors
    assert_raises(Zubra::Error) { @zubra.html("nope") }
    Dir.mktmpdir do |dir|
      File.write(File.join(dir, "broken-one.zb"), "<broken-one>{</broken-one>\n")
      broken = Zubra.new(dir, compiler: COMPILER)
      error = assert_raises(Zubra::Error) { broken.html("broken-one") }
      refute_empty error.message
      broken.close
    end
  end

  def test_a_compiler_that_does_not_answer_is_replaced
    Dir.mktmpdir do |dir|
      slow = File.join(dir, "slow")
      File.write(slow, "#!/bin/sh\nsleep 5\n")
      File.chmod(0o755, slow)
      zubra = Zubra.new(COMPONENTS, compiler: slow, timeout: 0.3)
      error = assert_raises(Zubra::Error) { zubra.html("status-pill") }
      assert_match(/didn't answer within 0.3s/, error.message)
      assert_nil zubra.instance_variable_get(:@process), "the process that didn't answer is stopped, so its late answer can't reach the next request"
      zubra.close
      dead = File.join(dir, "dead")
      File.write(dead, "#!/bin/sh\nexit 0\n")
      File.chmod(0o755, dead)
      zubra = Zubra.new(COMPONENTS, compiler: dead)
      assert_match(/stopped/, assert_raises(Zubra::Error) { zubra.html("status-pill") }.message)
      zubra.close
    end
    assert_includes @zubra.html("status-pill"), "<status-pill", "the real one still answers"
  end

  def test_no_compiler_says_how_to_get_one
    error = assert_raises(Zubra::Error) { Zubra.new(COMPONENTS, compiler: "/no/such/zubra").html("status-pill") }
    assert_match(/can't run the compiler/, error.message)
  end
end

# Rails without Rails: the helper on an object with a request, and the middleware and module
# endpoint as plain Rack apps.
class ZubraRailsTest < Minitest::Test
  Request = Struct.new(:env)

  class View
    include Zubra::Rails::Helper
    attr_reader :request

    def initialize(env)
      @request = Request.new(env)
    end
  end

  def setup
    skip "no compiler" unless COMPILER
    Zubra::Rails.instance = Zubra.new(COMPONENTS, compiler: COMPILER)
  end

  def teardown
    Zubra::Rails.instance&.close
    Zubra::Rails.instance = nil
  end

  def layout(view)
    # A layout's head before the view's body, as Rails renders them into the page.
    "<html><head>#{view.zubra_head}</head><body>#{view.zubra('status-pill', status: 'taken', waiting: 2)}#{view.zubra_scripts}</body></html>"
  end

  def test_the_middleware_fills_the_head_after_the_body_rendered
    app = Zubra::Rails::Middleware.new(lambda do |env|
      html = layout(View.new(env))
      [200, { "content-type" => "text/html; charset=utf-8", "content-length" => html.bytesize.to_s }, [html]]
    end)
    status, headers, body = app.call({})
    html = body.join
    assert_equal 200, status
    assert_match(%r{<head><style data-zb-components>.*\[data-status=open\].*</style></head>}m, html)
    assert_includes html, "import '/components/status-pill.js';"
    refute_includes html, "<!--zubra:"
    assert_equal html.bytesize.to_s, headers["content-length"]
  end

  HOSTILE = "<!--zubra:scripts:x--><!--zubra:head--><!--zubra:scripts:/evil/-->"

  def test_a_marker_in_the_page_s_own_text_is_left_alone
    # Security audit Z4: only the markers the helpers wrote, with the request's token, are filled.
    app = Zubra::Rails::Middleware.new(lambda do |env|
      view = View.new(env)
      html = "<html><head>#{view.zubra_head}</head><body>#{view.zubra('status-pill', status: 'open')}<article>#{HOSTILE}</article>#{view.zubra_scripts}</body></html>"
      [200, { "content-type" => "text/html" }, [html]]
    end)
    html = app.call({})[2].join
    assert_includes html, "<article>#{HOSTILE}</article>", "the visitor's text is as they wrote it"
    refute_includes html.sub(HOSTILE, ""), "/evil/"
    assert_equal 1, html.scan('<script type="module">').length, "one script: the layout's"
    assert_equal 1, html.scan("<style data-zb-components>").length
  end

  def test_fill_puts_the_head_in_as_it_is
    # The block form of sub: a backslash sequence in the CSS isn't read as a back-reference.
    page = Struct.new(:head, :scripts_for) do
      def scripts(_base) = ""
    end.new('<style>.a::before { content: "\\0 \\1 \\&"; }</style>', nil)
    html = Zubra::Rails.fill("<head>#{Zubra::Rails.head_marker('t')}</head>", page, "t")
    assert_equal '<head><style>.a::before { content: "\\0 \\1 \\&"; }</style></head>', html
  end

  def test_each_request_has_its_own_page
    seen = []
    app = Zubra::Rails::Middleware.new(->(env) { seen << env["zubra.page"]; [200, { "content-type" => "text/plain" }, ["x"]] })
    app.call({})
    app.call({})
    refute_same seen[0], seen[1]
    assert_equal [200, { "content-type" => "text/plain" }, ["x"]], app.call({}), "not HTML: untouched"
  end

  def test_without_the_middleware_the_helpers_render_in_place
    view = View.new({})
    assert_equal "", view.zubra_head
    view.zubra("status-pill")
    assert_includes view.zubra_head, "<style data-zb-components>"
    assert_includes view.zubra_scripts("/c/"), "import '/c/status-pill.js';"
  end

  def test_the_modules_endpoint
    status, headers, body = Zubra::Rails::Modules.new.call({ "PATH_INFO" => "/status-pill.js" })
    assert_equal 200, status
    assert_equal "text/javascript; charset=utf-8", headers["content-type"]
    assert_includes body.join, 'from "@zubra/runtime"'
    assert_equal 404, Zubra::Rails::Modules.new.call({ "PATH_INFO" => "/nope.js" })[0]
  end
end

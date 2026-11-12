# frozen_string_literal: true

# Zubra in a Ruby app, with no Node.js on the server: components are rendered to HTML by the
# zubra compiler (a Rust binary) running as one long-lived `zubra serve` process, and served to
# the browser as ES modules it compiles too. The browser hydrates the server's markup in place.
#
#   zubra = Zubra.new("app/components")          # a folder of .zb files
#   page = zubra.page                            # one per request: records what the page used
#   page.render("plot-map", plots: plots)        # server-rendered HTML
#   page.head, page.scripts                      # for the layout: the CSS, then the modules
#
# The protocol is `zubra serve`'s JSON lines: one request per line on standard input, with every
# component's source, and one response per line back. Rails helpers are in zubra/rails.
#
# The compiler is found, in order: the `compiler:` argument, $ZUBRA_COMPILER, then `zubra` on the PATH.
require "json"
require "open3"
require "cgi"

class Zubra
  VERSION = "0.1.0"

  HOW_TO = "Download a binary from https://github.com/journey-to-code-org/zubra/releases and put it " \
           "on the PATH, or set ZUBRA_COMPILER to its path."

  # The compiler's message: a component that doesn't compile, or one that doesn't exist, or a
  # compiler that can't run, stops, or doesn't answer in time.
  class Error < StandardError; end

  def self.find_compiler
    return ENV["ZUBRA_COMPILER"] if ENV["ZUBRA_COMPILER"] && !ENV["ZUBRA_COMPILER"].empty?

    ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).map { |dir| File.join(dir, "zubra") }.find { |path| File.executable?(path) }
  end

  attr_reader :dir, :compiler, :timeout

  # `timeout` is how long one request may take, in seconds (nil: no limit). A request that takes
  # longer raises Zubra::Error and the compiler process is replaced.
  def initialize(components, compiler: nil, cache: true, timeout: 30)
    @dir = File.expand_path(components.to_s)
    @compiler = compiler || self.class.find_compiler
    raise Error, "zubra: no compiler found. #{HOW_TO}" unless @compiler

    @cache = cache
    @timeout = timeout
    @lock = Mutex.new
    @process = nil
    @sources = nil
    @css = {}
    @js = {}
    at_exit { close }
  end

  # The components in the folder, by file name (`plot-map`).
  def names
    Dir.glob(File.join(@dir, "*.zb")).map { |path| File.basename(path, ".zb") }.sort
  end

  # One request to the compiler for component `name`; the output, or a Zubra::Error.
  def request(name, **request)
    raise Error, "no component #{name.inspect} in #{@dir}" unless names.include?(name)

    body = { path: "/components/#{name}.zb", files: files }.merge(request)
    response = @lock.synchronize do
      # One line out for one line in, in order: whatever ends a request early (the process dying,
      # a timeout, an exception) ends the process too, so the next request starts a fresh one.
      answered = false
      begin
        start unless alive?
        line = exchange(JSON.generate(body))
        parsed = begin
          JSON.parse(line)
        rescue JSON::ParserError
          raise Error, "#{@compiler} serve answered with something that isn't JSON: #{line[0, 200].inspect}"
        end
        answered = true
        parsed
      ensure
        stop unless answered
      end
    end
    raise Error, response["error"] unless response["ok"]

    response["output"]
  end

  # Component `name` as HTML for `props`; `slots` is markup your server already rendered.
  def html(name, props = {}, slots = {})
    request(name, emit: "html", props: props, slots: slots, slotSource: "html", partial: true)
  end

  # The component's scoped CSS, including that of the components it imports.
  def css(name)
    return request(name, emit: "css") unless @cache

    @css[name] ||= request(name, emit: "css")
  end

  # The module that defines the component's element (serve it as /components/<name>.js).
  def js(name, runtime: "@zubra/runtime")
    return request(name, emit: "js", runtime: runtime) unless @cache

    @js["#{name}\0#{runtime}"] ||= request(name, emit: "js", runtime: runtime)
  end

  # Stop the compiler process (it also stops when Ruby exits).
  def close
    @lock.synchronize { stop }
  end

  def page
    Page.new(self)
  end

  private

  def files
    return @sources if @sources && @cache

    @sources = Dir.glob(File.join(@dir, "*.zb")).sort.to_h do |path|
      ["/components/#{File.basename(path)}", File.read(path, encoding: "utf-8")]
    end
  end

  def alive?
    @process && @process[:thread].alive?
  end

  def start
    stop
    stdin, stdout, thread = Open3.popen2(@compiler, "serve")
    @process = { stdin: stdin, stdout: stdout, thread: thread }
  rescue SystemCallError => e
    raise Error, "zubra: can't run the compiler at #{@compiler.inspect} (#{e.message}). #{HOW_TO}"
  end

  def stop
    process, @process = @process, nil
    return unless process

    process[:stdin].close unless process[:stdin].closed?
    unless process[:thread].join(1)
      Process.kill("KILL", process[:thread].pid) rescue nil
      process[:thread].join
    end
    process[:stdout].close unless process[:stdout].closed?
  end

  def exchange(line)
    @process[:stdin].write(line, "\n")
    @process[:stdin].flush
    unless IO.select([@process[:stdout]], nil, nil, @timeout)
      raise Error, "#{@compiler} serve didn't answer within #{@timeout}s; it has been restarted"
    end

    answer = @process[:stdout].gets
    raise Error, "#{@compiler} serve stopped" unless answer

    answer
  rescue Errno::EPIPE, IOError
    raise Error, "#{@compiler} serve stopped"
  end

  # What one page rendered, so its layout can add those components' CSS and modules.
  class Page
    attr_reader :zubra, :modules

    def initialize(zubra)
      @zubra = zubra
      @modules = []
    end

    def render(name, slots: {}, **props)
      html = @zubra.html(name, props, slots)
      @modules << name unless @modules.include?(name)
      html
    end

    # The CSS of every component the page rendered (and what they import).
    def styles
      @modules.map { |name| @zubra.css(name) }.join("\n")
    end

    # <style data-zb-components>…</style>, for the layout's <head>; empty if nothing rendered.
    def head
      @modules.empty? ? "" : "<style data-zb-components>#{styles}</style>"
    end

    # The <script type="module"> that loads each rendered component from `base`<name>.js; empty
    # if nothing rendered. (The page works without it.)
    def scripts(base = "/components/")
      return "" if @modules.empty?

      imports = @modules.map { |name| "    import '#{CGI.escapeHTML(base)}#{name}.js';\n" }.join
      "<script type=\"module\">\n#{imports}  </script>"
    end
  end
end

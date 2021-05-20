const mem = require('./mem.js');
const magic = require('./magic.js');
const png = require('../png/node.js');
const codecs = require('../node/index.js');
const { default: framebuffer } = require('./framebuffer.js');

const wasm = {
  svg: require('../wasm/node/svg.js'),
  gif: require('../wasm/node/gif.js'),
  jpeg: require('../wasm/node/jpeg.js'),
  tiff: require('../wasm/node/tiff.js'),
  // font: require('../wasm/node/font.js'),
}

const animation_formats = ['gif'];
const image_formats = ['png', 'jpeg', 'tiff'];
const all_formats = ['png', 'gif', 'jpeg', 'tiff'];

async function load(buffer) {
  const u8 = mem.view(buffer);
  if (0 === u8.length) throw new TypeError('empty buffer');

  const meta = magic.buffer(u8);
  if (!meta) throw new Error('unknown file format');
  if ('image' !== meta.type) throw new Error('unsupported file type');
  if (!all_formats.includes(meta.format)) throw new Error('unsupported image format');

  if ('gif' === meta.format) return Animation.decode('gif', u8);
  const frame = 'png' === meta.format ? png.decode(u8) : (await wasm[meta.format].init()).load(u8);

  return new Image(frame.width, frame.height, frame.buffer);
}

class Frame {
  timestamp = 0;
  dispose = 'any';

  constructor(width, height, buffer) {
    this.image = buffer instanceof Image ? buffer : new Image(width | 0, height | 0, buffer);
  }

  get width() { return this.image.width; }
  get height() { return this.image.height; }
  static from(framebuffer) { return new Frame(framebuffer.width, framebuffer.height, framebuffer.u8 || framebuffer.buffer); }

  clone() {
    const frame = new Frame(this.width, this.height, this.image.clone());

    frame.dispose = this.dispose;
    frame.timestamp = this.timestamp;

    return frame;
  }
}

class Image extends framebuffer {
  constructor(width, height, buffer) {
    super(width, height, buffer || new Uint8Array(4 * width * height));
  }

  clone() { return new Image(this.width, this.height, this.u8.slice()); }
  static from(framebuffer) { return new Image(framebuffer.width, framebuffer.height, framebuffer.u8 || framebuffer.buffer); }

  async encode(format, options = {}) {
    if ('png' === format) return codecs.png.encode(this.u8, { ...options, width: this.width, height: this.height });
    if ('jpeg' === format) return codecs.jpeg.encode(this.u8, { ...options, width: this.width, height: this.height });
    if ('webp' === format) return codecs.webp.encode(this.u8, { ...options, width: this.width, height: this.height });

    throw new TypeError('invalid image format');
  }

  static async decode(format, buffer, options = {}) {
    buffer = mem.view('string' === typeof buffer ? Buffer.from(buffer) : buffer);

    if ('auto' === format) {
      const meta = magic.buffer(buffer);
      if (!meta) throw new Error('unknown file format');
      if ('image' !== meta.type) throw new Error('unsupported file type');
      if (!image_formats.includes(meta.format)) throw new Error('unsupported image format');

      format = meta.format;
    }

    let frame;
    if ('svg' === format) frame = (await wasm.svg.init()).load(buffer, options.fit ?? null);

    else if (format in wasm) frame = (await wasm[format].init()).load(buffer);

    if (!frame) throw new TypeError('invalid image format');
    return new Image(frame.width, frame.height, frame.buffer);
  }
}

class Animation {
  width = 0;
  height = 0;
  frames = [];
  repeat = Infinity;

  constructor(width, height) {
    this.width = width | 0;
    this.height = height | 0;
  }

  clear() { this.frames.length = 0; }
  [Symbol.iterator]() { return this.frames.values(); }

  add(frame) {
    if (this.width !== frame.width) throw new Error('invalid frame width');
    else if (this.height !== frame.height) throw new Error('invalid frame height');

    this.frames.push(frame);
  }

  resize(type, width, height) {
    this.width = width | 0;
    this.height = height | 0;
    for (const frame of this) frame.image.resize(type, this.width, this.height);
  }

  async encode(format, options = {}) {
    if ('gif' === format) {
      const quality = options.quality ?? 95;
      const encoder = new codecs.gif.encoder(this.width, this.height);

      let prev = { timestamp: 0 };
      for (const frame of this) {
        if (!(frame instanceof Frame)) throw new Error('GIF contains invalid frames');

        encoder.add(frame.image.u8, {
          x: 0,
          y: 0,
          quality,
          width: frame.width,
          speed: options.speed,
          height: frame.height,
          colors: options.colors,
          dispose: frame.dispose,
          delay: ((frame.timestamp - prev.timestamp) / 10) | 0,
        });

        prev = frame;
      }

      const repeat = options.repeat ?? this.repeat;
      return encoder.finish({ ...options, repeat: Infinity === repeat ? null : repeat });
    }

    throw new TypeError('invalid image format');
  }

  static async decode(format, buffer, options = {}) {
    buffer = mem.view(buffer);

    if ('auto' === format) {
      const meta = magic.buffer(buffer);
      if (!meta) throw new Error('unknown file format');
      if ('image' !== meta.type) throw new Error('unsupported file type');
      if (!animation_formats.includes(meta.format)) throw new Error('unsupported image format');

      format = meta.format;
    }

    if ('gif' === format) {
      const decoder = new (await wasm.gif.init()).Decoder(buffer);

      const gwidth = decoder.width | 0;
      const gheight = decoder.height | 0;
      const animation = new Animation(gwidth, gheight);
      const u32 = new Uint32Array(decoder.width * decoder.height);
      const u8 = new Uint8Array(u32.buffer, u32.byteOffset, u32.byteLength);

      let prev = { timestamp: 0 };
      const frames = animation.frames;
      for (const frame of decoder.frames()) {
        let offset8 = 0 | 0;
        let offset32 = 0 | 0;
        const fx = frame.x | 0;
        const fy = frame.y | 0;
        const f8 = frame.buffer;
        const mode = frame.dispose;
        const width = frame.width | 0;
        const height = frame.height | 0;
        const f = frames[frames.push(new Frame(gwidth, gheight)) - 1];
        const f32 = new Uint32Array(f8.buffer, f8.byteOffset, width * height);

        const t8 = f.image.u8;
        f.dispose = 'background';
        const t32 = new Uint32Array(t8.buffer);
        f.timestamp = prev.timestamp + 10 * frame.delay;

        prev = f;
        t8.set(u8);

        if (2 === mode) {
          for (let y = 0 | 0; y < height; y++) {
            const y_offset = fx + gwidth * (y + fy) | 0;

            for (let x = 0 | 0; x < width; x++) {
              const x_offset = x + y_offset;

              if (0 === f8[3 + offset8])
                t32[x_offset] = u32[x_offset];
              else t32[x_offset] = f32[offset32];

              offset32++;
              offset8 += 4;
            }
          }
        }

        else if (3 === mode) {
          for (let y = 0 | 0; y < height; y++) {
            const y_offset = fx + gwidth * (y + fy) | 0;

            for (let x = 0 | 0; x < width; x++) {
              const x_offset = x + y_offset;

              if (0 === f8[3 + offset8])
                t32[x_offset] = u32[x_offset];
              else t32[x_offset] = f32[offset32];

              offset32++;
              offset8 += 4;
              u32[x_offset] = 0;
            }
          }
        }

        else if (0 === mode || 1 === mode) {
          t8.set(u8)
          for (let y = 0 | 0; y < height; y++) {
            const y_offset = fx + gwidth * (y + fy) | 0;

            for (let x = 0 | 0; x < width; x++) {
              const x_offset = x + y_offset;

              if (0 === f8[3 + offset8])
                t32[x_offset] = u32[x_offset];
              else t32[x_offset] = f32[offset32];

              offset32++;
              offset8 += 4;
              u32[x_offset] = t32[x_offset];
            }
          }
        }
      }

      return animation;
    }

    throw new TypeError('invalid image format');
  }
}

module.exports = { load, Image, Frame, Animation };
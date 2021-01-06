import { WASI } from "@wasmer/wasi";
import { WasmFs } from "@wasmer/wasmfs";
import { inflate } from "pako";
import { dlinit } from "@root/dlinit";
import { initFS } from "@root/filesystem";
import * as path from "path";

const PAGE_SIZE = 65536;

const assertPluginExports = (pluginInstance) => {
  if (
    !pluginInstance ||
    typeof pluginInstance !== "object" ||
    typeof pluginInstance.exports !== "object"
  ) {
    console.error("Error instantiating a csound plugin, instance and/or export is missing!");
    return false;
  } else if (!pluginInstance.exports.__wasm_call_ctors) {
    console.error(
      "A csound plugin didn't export __wasm_call_ctors.\n" +
        "Please re-run wasm-ld with either --export-all or include --export=__wasm_call_ctors",
    );
    return false;
  } else if (
    !pluginInstance.exports.csoundModuleCreate &&
    !pluginInstance.exports.csound_opcode_init &&
    !pluginInstance.exports.csound_fgen_init
  ) {
    console.error(
      "A csound plugin turns out to be neither a plugin, opcode or module.\n" +
        "Perhaps csdl.h or module.h wasn't imported correctly?",
    );
    return false;
  } else {
    return true;
  }
};

const getBinaryHeaderData = (wasmBytes) => {
  const magicBytes = new Uint32Array(new Uint8Array(wasmBytes.subarray(0, 24)).buffer);
  if (magicBytes[0] !== 0x6d736100) {
    console.error("Wasm magic number is missing!");
  }
  if (wasmBytes[8] !== 0) {
    console.log("Dylink section wasn't found in wasm binary, assuming static wasm.");
    return "static";
  }

  let next = 9;
  function getLEB() {
    var ret = 0;
    var mul = 1;
    while (1) {
      var byte = wasmBytes[next++];
      ret += (byte & 0x7f) * mul;
      mul *= 0x80;
      if (!(byte & 0x80)) break;
    }
    return ret;
  }
  const sectionSize = getLEB();
  // 6, size of "dylink" string = 7
  next += 7;
  const memorySize = getLEB();
  const memoryAlign = getLEB();
  const tableSize = getLEB();
  const tableAlign = getLEB();
  const neededDynlibsCount = getLEB();
  return { sectionSize, memorySize, memoryAlign, neededDynlibsCount, tableSize, tableAlign };
};

// currently dl is default, static is good for low level debugging
const loadStaticWasm = async ({ wasmBytes, wasi, messagePort }) => {
  const module = await WebAssembly.compile(wasmBytes);
  const options = wasi.getImports(module);
  options["env"] = options["env"] || {};
  options["env"]["csoundLoadModules"] = () => 0;
  const instance = await WebAssembly.instantiate(module, options);
  wasi.start(instance);
  await initFS(wasmFs, messagePort);
  return instance;
};

export default async function ({ wasmDataURI, withPlugins = [], messagePort }) {
  const wasmFs = new WasmFs();
  const bindings = {
    ...WASI.defaultBindings,
    fs: wasmFs.fs,
    path,
  };
  const wasi = new WASI({
    // --dir <wasm path>:<host path>
    preopens: {
      "/": "/",
    },
    env: {},
    bindings,
  });
  await wasmFs.volume.mkdirpSync("/sandbox");

  const wasmZlib = new Uint8Array(wasmDataURI);
  const wasmBytes = inflate(wasmZlib);
  const magicData = getBinaryHeaderData(wasmBytes);
  if (magicData === "static") {
    return [await loadStaticWasm({ messagePort, wasmBytes, wasi }), wasmFs];
  }
  const { memorySize, memoryAlign, tableSize } = magicData;
  // get the header data from plugins which we need before
  // initializing the main module
  withPlugins = withPlugins.reduce((acc, wasmPlugin) => {
    let wasmPluginBytes;
    let pluginHeaderData;
    try {
      wasmPluginBytes = new Uint8Array(wasmPlugin);
      pluginHeaderData = getBinaryHeaderData(wasmPluginBytes);
    } catch (error) {
      console.error("Error in plugin", error);
    }
    if (pluginHeaderData) {
      acc.push({ headerData: pluginHeaderData, wasmPluginBytes });
    }
    return acc;
  }, []);

  const fixedMemoryBase = 512;
  const initialMemory = Math.ceil((memorySize + memoryAlign) / PAGE_SIZE);
  const pluginsMemory = Math.ceil(
    withPlugins.reduce(
      (acc, { headerData: { memorySize } }) => acc + (memorySize + memoryAlign),
      0,
    ) / PAGE_SIZE,
  );
  const totalInitialMemory = initialMemory + pluginsMemory + fixedMemoryBase;

  const memory = new WebAssembly.Memory({
    initial: totalInitialMemory,
  });

  const table = new WebAssembly.Table({ initial: tableSize + 1, element: "anyfunc" });

  const stackPointer = new WebAssembly.Global(
    { value: "i32", mutable: true },
    totalInitialMemory * PAGE_SIZE,
  );
  const heapBase = new WebAssembly.Global(
    { value: "i32", mutable: true },
    totalInitialMemory * PAGE_SIZE,
  );
  const memoryBase = new WebAssembly.Global({ value: "i32", mutable: false }, fixedMemoryBase);
  const tableBase = new WebAssembly.Global({ value: "i32", mutable: false }, 1);
  const __dummy = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  const module = await WebAssembly.compile(wasmBytes);
  const options = wasi.getImports(module);

  let withPlugins_ = [];
  let instance;
  const csoundLoadModules = (csoundInstance) => {
    withPlugins_.forEach((pluginInstance) => {
      if (instance) {
        dlinit(instance, pluginInstance, table, csoundInstance);
      } else {
        console.error("csound-wasm internal: timing problem detected!");
      }
    });
    return 0;
  };

  options["env"] = options["env"] || {};
  options["env"]["memory"] = memory;
  options["env"]["__indirect_function_table"] = table;
  options["env"]["__stack_pointer"] = stackPointer;
  options["env"]["__memory_base"] = memoryBase;
  options["env"]["__table_base"] = tableBase;
  options["env"]["csoundLoadModules"] = csoundLoadModules;

  options["GOT.mem"] = options["GOT.mem"] || {};
  options["GOT.mem"]["__heap_base"] = heapBase;

  options["GOT.func"] = options["GOT.func"] || {};

  instance = await WebAssembly.instantiate(module, options);

  const moduleExports = Object.assign({}, instance.exports);
  const instance_ = {};
  instance_["exports"] = Object.assign(moduleExports, {
    memory,
  });

  let currentMemorySegment = initialMemory;

  withPlugins_ = await withPlugins.reduce(async (acc, { headerData, wasmPluginBytes }) => {
    acc = await acc;
    try {
      const {
        memorySize: pluginMemorySize,
        memoryAlign: pluginMemoryAlign,
        tableSize: pluginTableSize,
      } = headerData;

      const plugin = await WebAssembly.compile(wasmPluginBytes);
      const pluginOptions = {};
      const pluginMemoryBase = new WebAssembly.Global(
        { value: "i32", mutable: false },
        currentMemorySegment * PAGE_SIZE,
      );

      table.grow(pluginTableSize);
      pluginOptions["wasi_snapshot_preview1"] = options["wasi_snapshot_preview1"] || {};
      pluginOptions["env"] = Object.assign(pluginOptions["env"] || {}, {});
      pluginOptions["env"]["memory"] = memory;
      pluginOptions["env"]["__indirect_function_table"] = table;
      pluginOptions["env"]["__memory_base"] = pluginMemoryBase;
      pluginOptions["env"]["__stack_pointer"] = stackPointer;
      pluginOptions["env"]["__table_base"] = tableBase;
      pluginOptions["env"]["csoundLoadModules"] = __dummy;

      currentMemorySegment += Math.ceil((pluginMemorySize + pluginMemoryAlign) / PAGE_SIZE);
      const pluginInstance = await WebAssembly.instantiate(plugin, pluginOptions);
      if (assertPluginExports(pluginInstance)) {
        pluginInstance.exports.__wasm_call_ctors();
        acc.push(pluginInstance);
      }
    } catch (error) {
      console.error("Error while compiling csound-plugin", error);
    }
    return acc;
  }, []);

  wasi.start(instance_);
  await initFS(wasmFs, messagePort);
  return [instance_, wasmFs];
}

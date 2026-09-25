/**
 * SBS — minimal glTF 2.0 binary (.glb) writer: ONE skinned mesh + its skeleton.
 * ────────────────────────────────────────────────────────────────────────────
 * 🧤 V0.3.4.139. The hand rig goes out as a skinned proxy hand (every vertex
 * weighted 100 % to its bone) so a DCC app (3ds Max) shows both the bones and
 * the shape they drive; the user skins a real hand mesh to the same bones and
 * the file comes back as a .glb (systems/hands.js reads it with GLTFLoader).
 *
 * In-house on purpose (like electron/collect-zip.js): three's GLTFExporter is
 * not vendored, the format is small, and this writes exactly what is needed —
 * no extensions, no Draco, no textures.
 *
 * Layout: nodes = the bones (index 0 = the root) then the mesh node; one
 * skin over all bones; one primitive POSITION / NORMAL / JOINTS_0 (u16) /
 * WEIGHTS_0 (f32), u32 indices; one PBR material with a flat colour.
 */

const GL_ARRAY_BUFFER = 34962, GL_ELEMENT_ARRAY_BUFFER = 34963;
const GL_FLOAT = 5126, GL_UNSIGNED_SHORT = 5123, GL_UNSIGNED_INT = 5125;

/**
 * @param {object} o
 * @param {{name:string, parent:number, position:number[], quaternion:number[]}[]} o.bones  parent = index or -1 (exactly one root, at index 0)
 * @param {Float32Array} o.positions            xyz per vertex, in the mesh's (bind) space
 * @param {Float32Array} o.normals              xyz per vertex
 * @param {Uint32Array|Uint16Array|number[]} o.indices
 * @param {Uint16Array} o.joints                4 bone indices per vertex
 * @param {Float32Array} o.weights              4 weights per vertex
 * @param {Float32Array} o.inverseBindMatrices  16 floats per bone, column-major
 * @param {number[]} [o.color]                  base colour rgb 0..1
 * @param {string} [o.name]
 * @param {object} [o.extras]                   goes into asset.extras
 * @returns {ArrayBuffer} the .glb bytes
 */
export function skinnedMeshGlb({ bones, positions, normals, indices, joints, weights, inverseBindMatrices, color = [0.9, 0.71, 0.59], name = 'mesh', extras = null }) {
  const nV = positions.length / 3;
  if (!bones?.length) throw new Error('glb: no bones');
  if (normals.length !== positions.length) throw new Error('glb: normals/positions mismatch');
  if (joints.length !== nV * 4 || weights.length !== nV * 4) throw new Error('glb: joints/weights must be 4 per vertex');
  if (inverseBindMatrices.length !== bones.length * 16) throw new Error('glb: one inverse bind matrix per bone');

  // ── binary chunk: every view 4-byte aligned ───────────────────────────────
  const views = [], accessors = [];
  const parts = [];
  let byteLength = 0;
  const pushView = (typed, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); byteLength += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    views.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    parts.push(bytes); byteLength += bytes.byteLength;
    return views.length - 1;
  };
  const pushAccessor = (viewIdx, componentType, count, type, extra = {}) => {
    accessors.push({ bufferView: viewIdx, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const minMax3 = (arr) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { const v = arr[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    return { min, max };
  };

  const pos = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const nor = normals   instanceof Float32Array ? normals   : new Float32Array(normals);
  const idx = new Uint32Array(indices);
  const jnt = joints    instanceof Uint16Array  ? joints    : new Uint16Array(joints);
  const wgt = weights   instanceof Float32Array ? weights   : new Float32Array(weights);
  const ibm = inverseBindMatrices instanceof Float32Array ? inverseBindMatrices : new Float32Array(inverseBindMatrices);

  const accPos = pushAccessor(pushView(pos, GL_ARRAY_BUFFER),         GL_FLOAT,          nV,           'VEC3', minMax3(pos));
  const accNor = pushAccessor(pushView(nor, GL_ARRAY_BUFFER),         GL_FLOAT,          nV,           'VEC3');
  const accJnt = pushAccessor(pushView(jnt, GL_ARRAY_BUFFER),         GL_UNSIGNED_SHORT, nV,           'VEC4');
  const accWgt = pushAccessor(pushView(wgt, GL_ARRAY_BUFFER),         GL_FLOAT,          nV,           'VEC4');
  const accIdx = pushAccessor(pushView(idx, GL_ELEMENT_ARRAY_BUFFER), GL_UNSIGNED_INT,   idx.length,   'SCALAR');
  const accIbm = pushAccessor(pushView(ibm, 0),                       GL_FLOAT,          bones.length, 'MAT4');

  // ── nodes ─────────────────────────────────────────────────────────────────
  const nodes = bones.map((b) => {
    const n = { name: b.name };
    if (b.position && b.position.some(v => v !== 0)) n.translation = b.position.map(Number);
    if (b.quaternion && (b.quaternion[3] !== 1 || b.quaternion.slice(0, 3).some(v => v !== 0))) n.rotation = b.quaternion.map(Number);
    return n;
  });
  bones.forEach((b, i) => { if (b.parent >= 0) { (nodes[b.parent].children ||= []).push(i); } });
  const roots = bones.map((b, i) => b.parent < 0 ? i : -1).filter(i => i >= 0);
  const meshNode = nodes.length;
  nodes.push({ name: `${name}_mesh`, mesh: 0, skin: 0 });

  const json = {
    asset: { version: '2.0', generator: 'SBS Step Browser', ...(extras ? { extras } : {}) },
    scene: 0,
    scenes: [{ name, nodes: [...roots, meshNode] }],
    nodes,
    skins: [{ name: `${name}_skin`, skeleton: roots[0], joints: bones.map((_, i) => i), inverseBindMatrices: accIbm }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: accPos, NORMAL: accNor, JOINTS_0: accJnt, WEIGHTS_0: accWgt }, indices: accIdx, material: 0, mode: 4 }] }],
    materials: [{ name: `${name}_material`, pbrMetallicRoughness: { baseColorFactor: [color[0], color[1], color[2], 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength }],
  };

  // ── GLB container: header + JSON chunk (space-padded) + BIN chunk (zero-padded) ──
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad  = (4 - (byteLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + byteLength + binPad;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out), u8 = new Uint8Array(out);
  let o = 0;
  dv.setUint32(o, 0x46546C67, true); o += 4;   // 'glTF'
  dv.setUint32(o, 2, true);          o += 4;
  dv.setUint32(o, total, true);      o += 4;
  dv.setUint32(o, jsonBytes.length + jsonPad, true); o += 4;
  dv.setUint32(o, 0x4E4F534A, true); o += 4;   // 'JSON'
  u8.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) u8[o++] = 0x20;
  dv.setUint32(o, byteLength + binPad, true); o += 4;
  dv.setUint32(o, 0x004E4942, true); o += 4;   // 'BIN\0'
  for (const p of parts) { u8.set(p, o); o += p.byteLength; }
  o += binPad;   // zero already
  return out;
}

/**
 * SBS — minimal FBX 7.4 ASCII writer: ONE skinned mesh + its skeleton.
 * ─────────────────────────────────────────────────────────────────────
 * 🧤 V0.3.4.140. The user's 3ds Max does not open .glb, so the hand rig also
 * goes out as FBX — the format every DCC app reads. ASCII 7.4 on purpose: no
 * compression, no binary framing, and three's own FBXLoader (vendored) reads
 * 7.x ASCII, which is how this writer is tested headless.
 *
 * Same input contract as io/glb-write.js, plus the bones' GLOBAL bind
 * matrices (a cluster's TransformLink). Bones are LimbNodes with a Skeleton
 * node attribute (Max makes Bone objects of them), the mesh a Model + Geometry
 * with a Skin deformer and one Cluster per bone that owns vertices, a BindPose
 * for the lot, one Phong material. Rotations are FBX "Lcl Rotation" Eulers
 * (degrees, XYZ order = three's 'ZYX').
 */

const _num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const s = Math.abs(n) < 1e-9 ? '0' : n.toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
// Long arrays wrap the way Autodesk's own writer wraps them: the continuation
// lines start at column 0 (a reader that keys on indentation — three's
// FBXLoader among them — treats an indented continuation as noise).
const _arr = (values, perLine = 60) => {
  const out = [];
  for (let i = 0; i < values.length; i += perLine) out.push(Array.from(values.slice(i, i + perLine), _num).join(','));
  return out.join(',\n');
};
const _esc = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");

/** General 4×4 inverse of a column-major 16-array (three's Matrix4.invert, cofactors). */
function _inv4(m) {
  const [n11, n21, n31, n41, n12, n22, n32, n42, n13, n23, n33, n43, n14, n24, n34, n44] = Array.from(m, Number);
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (!det) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const d = 1 / det;
  return [
    t11 * d,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d,
    t12 * d,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d,
    t13 * d,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d,
    t14 * d,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d,
  ];
}

/** three's Euler 'ZYX' (= FBX eEulerXYZ) in degrees, from a unit quaternion [x,y,z,w]. */
function _eulerDeg(q) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  // rotation matrix (row r, column c)
  const m11 = 1 - 2 * (yy + zz), m12 = 2 * (xy - wz), m13 = 2 * (xz + wy);
  const m21 = 2 * (xy + wz),     m22 = 1 - 2 * (xx + zz), m23 = 2 * (yz - wx);
  const m31 = 2 * (xz - wy),     m32 = 2 * (yz + wx),     m33 = 1 - 2 * (xx + yy);
  let ex, ey, ez;
  ey = Math.asin(-Math.max(-1, Math.min(1, m31)));
  if (Math.abs(m31) < 0.9999999) { ex = Math.atan2(m32, m33); ez = Math.atan2(m21, m11); }
  else { ex = 0; ez = Math.atan2(-m12, m22); }
  const D = 180 / Math.PI;
  return [ex * D, ey * D, ez * D];
}

/**
 * @param {object} o
 * @param {{name:string, parent:number, position:number[], quaternion:number[]}[]} o.bones  parent = index or -1
 * @param {Float32Array} o.positions   xyz per vertex in the mesh's (bind) space
 * @param {Float32Array} o.normals     xyz per vertex
 * @param {ArrayLike<number>} o.indices  triangles
 * @param {Uint16Array} o.joints       4 bone indices per vertex
 * @param {Float32Array} o.weights     4 weights per vertex
 * @param {Float32Array} o.bindMatrices  16 floats per bone, column-major: the bone's GLOBAL matrix at bind
 * @param {number[]} [o.color]         rgb 0..1
 * @param {string} [o.name]
 * @param {string} [o.creator]
 * @returns {string} the .fbx text (ASCII)
 */
export function skinnedMeshFbx({ bones, positions, normals, indices, joints, weights, bindMatrices, inverseBindMatrices = null, color = [0.9, 0.71, 0.59], name = 'mesh', creator = 'SBS Step Browser', unitScale = 0.1, writeBindPose = true }) {
  const nV = positions.length / 3;
  if (!bones?.length) throw new Error('fbx: no bones');
  if (normals.length !== positions.length) throw new Error('fbx: normals/positions mismatch');
  if (joints.length !== nV * 4 || weights.length !== nV * 4) throw new Error('fbx: joints/weights must be 4 per vertex');
  if (bindMatrices.length !== bones.length * 16) throw new Error('fbx: one bind matrix per bone');
  if (indices.length % 3) throw new Error('fbx: triangles only');

  const ID = { geom: 100000, mesh: 200000, bone: (i) => 300000 + i, attr: (i) => 400000 + i, mat: 500000, skin: 600000, cluster: (i) => 700000 + i, pose: 800000, doc: 900000 };
  const meshName = _esc(name);

  // per-bone vertex lists (a cluster only for bones that own vertices)
  const perBone = bones.map(() => ({ idx: [], w: [] }));
  for (let v = 0; v < nV; v++) {
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k];
      if (w > 0) { const b = joints[v * 4 + k]; perBone[b].idx.push(v); perBone[b].w.push(w); }
    }
  }
  const clusterBones = bones.map((_, i) => i).filter(i => perBone[i].idx.length);

  // a LimbNode's Size is what Max draws at the joint (measured on import:
  // length = width = Size × unit × 0.1, i.e. Size 40 = a 4 mm nub here). Our
  // joints point +Y along the bone while a Max bone draws along its X, so a
  // full-length bone shape would stick out sideways: small nubs, scaled a
  // little with the segment, mark the joints instead (a Dummy import shows
  // the same nubs as boxes).
  const segLen = (i) => {
    const child = bones.find(b => b.parent === i);
    if (child) { const p = child.position || [0, 0, 0]; return Math.hypot(p[0], p[1], p[2]); }
    return 0;
  };
  const boneSize = bones.map((b, i) => {
    let s = segLen(i);
    if (!(s > 1e-6)) s = b.parent >= 0 ? segLen(b.parent) : 0;
    return Math.max(20, Math.min(60, 1.5 * s || 30));
  });

  // polygon vertex index: triangles, last index of each written as -(i+1)
  const pvi = new Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { pvi[i] = indices[i]; pvi[i + 1] = indices[i + 1]; pvi[i + 2] = -(indices[i + 2] + 1); }

  const now = new Date();
  const L = [];
  const p = (s) => L.push(s);

  p('; FBX 7.4.0 project file');
  p('; ----------------------------------------------------');
  p('');
  p('FBXHeaderExtension:  {');
  p('\tFBXHeaderVersion: 1003');
  p('\tFBXVersion: 7400');
  p('\tCreationTimeStamp:  {');
  p('\t\tVersion: 1000');
  p(`\t\tYear: ${now.getFullYear()}`); p(`\t\tMonth: ${now.getMonth() + 1}`); p(`\t\tDay: ${now.getDate()}`);
  p(`\t\tHour: ${now.getHours()}`); p(`\t\tMinute: ${now.getMinutes()}`); p(`\t\tSecond: ${now.getSeconds()}`); p('\t\tMillisecond: 0');
  p('\t}');
  p(`\tCreator: "${_esc(creator)}"`);
  p('}');
  p('GlobalSettings:  {');
  p('\tVersion: 1000');
  p('\tProperties70:  {');
  p('\t\tP: "UpAxis", "int", "Integer", "",1');
  p('\t\tP: "UpAxisSign", "int", "Integer", "",1');
  p('\t\tP: "FrontAxis", "int", "Integer", "",2');
  p('\t\tP: "FrontAxisSign", "int", "Integer", "",1');
  p('\t\tP: "CoordAxis", "int", "Integer", "",0');
  p('\t\tP: "CoordAxisSign", "int", "Integer", "",1');
  p('\t\tP: "OriginalUpAxis", "int", "Integer", "",1');
  p('\t\tP: "OriginalUpAxisSign", "int", "Integer", "",1');
  p(`\t\tP: "UnitScaleFactor", "double", "Number", "",${_num(unitScale)}`);          // FBX counts in cm: 0.1 = our mm
  p(`\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",${_num(unitScale)}`);
  p('\t\tP: "AmbientColor", "ColorRGB", "Color", "",0,0,0');
  p('\t\tP: "DefaultCamera", "KString", "", "", "Producer Perspective"');
  p('\t\tP: "TimeMode", "enum", "", "",6');
  p('\t\tP: "TimeSpanStart", "KTime", "Time", "",0');
  p('\t\tP: "TimeSpanStop", "KTime", "Time", "",46186158000');
  p('\t\tP: "CustomFrameRate", "double", "Number", "",-1');
  p('\t}');
  p('}');
  p('Documents:  {');
  p('\tCount: 1');
  p(`\tDocument: ${ID.doc}, "", "Scene" {`);
  p('\t\tProperties70:  {');
  p('\t\t\tP: "SourceObject", "object", "", ""');
  p('\t\t\tP: "ActiveAnimStackName", "KString", "", "", ""');
  p('\t\t}');
  p('\t\tRootNode: 0');
  p('\t}');
  p('}');
  p('References:  {');
  p('}');

  // ── definitions (counts) ──────────────────────────────────────────────────
  const counts = { GlobalSettings: 1, Model: 1 + bones.length, Geometry: 1, NodeAttribute: bones.length, Material: 1, Deformer: 1 + clusterBones.length, Pose: writeBindPose ? 1 : 0 };
  p('Definitions:  {');
  p('\tVersion: 100');
  p(`\tCount: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  p('\tObjectType: "GlobalSettings" {');
  p('\t\tCount: 1');
  p('\t}');
  p('\tObjectType: "Model" {');
  p(`\t\tCount: ${counts.Model}`);
  p('\t\tPropertyTemplate: "FbxNode" {');
  p('\t\t\tProperties70:  {');
  p('\t\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0');
  p('\t\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0');
  p('\t\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1');
  p('\t\t\t\tP: "Visibility", "Visibility", "", "A",1');
  p('\t\t\t\tP: "RotationOrder", "enum", "", "",0');
  p('\t\t\t\tP: "InheritType", "enum", "", "",0');
  p('\t\t\t}');
  p('\t\t}');
  p('\t}');
  p('\tObjectType: "Geometry" {');
  p('\t\tCount: 1');
  p('\t}');
  p('\tObjectType: "NodeAttribute" {');
  p(`\t\tCount: ${counts.NodeAttribute}`);
  p('\t}');
  p('\tObjectType: "Material" {');
  p('\t\tCount: 1');
  p('\t}');
  p('\tObjectType: "Deformer" {');
  p(`\t\tCount: ${counts.Deformer}`);
  p('\t}');
  if (writeBindPose) {
    p('\tObjectType: "Pose" {');
    p('\t\tCount: 1');
    p('\t}');
  }
  p('}');

  // ── objects ───────────────────────────────────────────────────────────────
  p('Objects:  {');
  // geometry
  p(`\tGeometry: ${ID.geom}, "Geometry::${meshName}", "Mesh" {`);
  p(`\t\tVertices: *${positions.length} {`);
  p(`\t\t\ta: ${_arr(positions)}`);
  p('\t\t}');
  p(`\t\tPolygonVertexIndex: *${pvi.length} {`);
  p(`\t\t\ta: ${_arr(pvi)}`);
  p('\t\t}');
  p('\t\tGeometryVersion: 124');
  p('\t\tLayerElementNormal: 0 {');
  p('\t\t\tVersion: 101');
  p('\t\t\tName: ""');
  p('\t\t\tMappingInformationType: "ByVertice"');
  p('\t\t\tReferenceInformationType: "Direct"');
  p(`\t\t\tNormals: *${normals.length} {`);
  p(`\t\t\t\ta: ${_arr(normals)}`);
  p('\t\t\t}');
  p('\t\t}');
  p('\t\tLayerElementMaterial: 0 {');
  p('\t\t\tVersion: 101');
  p('\t\t\tName: ""');
  p('\t\t\tMappingInformationType: "AllSame"');
  p('\t\t\tReferenceInformationType: "IndexToDirect"');
  p('\t\t\tMaterials: *1 {');
  p('\t\t\t\ta: 0');
  p('\t\t\t}');
  p('\t\t}');
  p('\t\tLayer: 0 {');
  p('\t\t\tVersion: 100');
  p('\t\t\tLayerElement:  {');
  p('\t\t\t\tType: "LayerElementNormal"');
  p('\t\t\t\tTypedIndex: 0');
  p('\t\t\t}');
  p('\t\t\tLayerElement:  {');
  p('\t\t\t\tType: "LayerElementMaterial"');
  p('\t\t\t\tTypedIndex: 0');
  p('\t\t\t}');
  p('\t\t}');
  p('\t}');
  // the mesh node
  p(`\tModel: ${ID.mesh}, "Model::${meshName}", "Mesh" {`);
  p('\t\tVersion: 232');
  p('\t\tProperties70:  {');
  p('\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0');
  p('\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0');
  p('\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1');
  p('\t\t\tP: "DefaultAttributeIndex", "int", "Integer", "",0');
  p('\t\t}');
  p('\t\tShading: T');
  p('\t\tCulling: "CullingOff"');
  p('\t}');
  // the bones
  bones.forEach((b, i) => {
    const t = b.position || [0, 0, 0];
    const e = _eulerDeg(b.quaternion || [0, 0, 0, 1]);
    p(`\tModel: ${ID.bone(i)}, "Model::${_esc(b.name)}", "LimbNode" {`);
    p('\t\tVersion: 232');
    p('\t\tProperties70:  {');
    p(`\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",${_num(t[0])},${_num(t[1])},${_num(t[2])}`);
    p(`\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",${_num(e[0])},${_num(e[1])},${_num(e[2])}`);
    p('\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1');
    p('\t\t\tP: "DefaultAttributeIndex", "int", "Integer", "",0');
    p('\t\t}');
    p('\t\tShading: T');
    p('\t\tCulling: "CullingOff"');
    p('\t}');
    p(`\tNodeAttribute: ${ID.attr(i)}, "NodeAttribute::${_esc(b.name)}", "LimbNode" {`);
    p('\t\tProperties70:  {');
    p(`\t\t\tP: "Size", "double", "Number", "",${_num(boneSize[i])}`);
    p('\t\t}');
    p('\t\tTypeFlags: "Skeleton"');
    p('\t}');
  });
  // the material
  p(`\tMaterial: ${ID.mat}, "Material::${meshName}_skin", "" {`);
  p('\t\tVersion: 102');
  p('\t\tShadingModel: "phong"');
  p('\t\tMultiLayer: 0');
  p('\t\tProperties70:  {');
  p(`\t\t\tP: "DiffuseColor", "Color", "", "A",${_num(color[0])},${_num(color[1])},${_num(color[2])}`);
  p(`\t\t\tP: "Diffuse", "Vector3D", "Vector", "",${_num(color[0])},${_num(color[1])},${_num(color[2])}`);
  p('\t\t\tP: "SpecularColor", "Color", "", "A",0.2,0.2,0.2');
  p('\t\t\tP: "Shininess", "double", "Number", "",12');
  p('\t\t\tP: "Opacity", "double", "Number", "",1');
  p('\t\t}');
  p('\t}');
  // the skin + clusters
  p(`\tDeformer: ${ID.skin}, "Deformer::${meshName}_skin", "Skin" {`);
  p('\t\tVersion: 101');
  p('\t\tLink_DeformAcuracy: 50');
  p('\t\tSkinningType: "Linear"');
  p('\t}');
  for (const i of clusterBones) {
    const pb = perBone[i];
    const link = bindMatrices.subarray ? bindMatrices.subarray(i * 16, i * 16 + 16) : bindMatrices.slice(i * 16, i * 16 + 16);
    // The SDK calls Transform "the mesh's global matrix at bind" — but in the
    // FILE it is stored in the BONE's space: inverse(bone bind) × mesh global
    // (Max's own export shows it; Blender's exporter documents the trap). The
    // mesh sits at the origin, so it is the inverse bind matrix itself.
    const meshInBone = inverseBindMatrices
      ? (inverseBindMatrices.subarray ? inverseBindMatrices.subarray(i * 16, i * 16 + 16) : inverseBindMatrices.slice(i * 16, i * 16 + 16))
      : _inv4(link);
    p(`\tDeformer: ${ID.cluster(i)}, "SubDeformer::${_esc(bones[i].name)}", "Cluster" {`);
    p('\t\tVersion: 100');
    p('\t\tUserData: "", ""');
    p(`\t\tIndexes: *${pb.idx.length} {`);
    p(`\t\t\ta: ${_arr(pb.idx)}`);
    p('\t\t}');
    p(`\t\tWeights: *${pb.w.length} {`);
    p(`\t\t\ta: ${_arr(pb.w)}`);
    p('\t\t}');
    p('\t\tTransform: *16 {');
    p(`\t\t\ta: ${_arr(meshInBone)}`);
    p('\t\t}');
    p('\t\tTransformLink: *16 {');
    p(`\t\t\ta: ${_arr(link)}`);
    p('\t\t}');
    p('\t}');
  }
  // the bind pose
  if (writeBindPose) {
    p(`\tPose: ${ID.pose}, "Pose::BindPose", "BindPose" {`);
    p('\t\tType: "BindPose"');
    p('\t\tVersion: 100');
    p(`\t\tNbPoseNodes: ${1 + bones.length}`);
    p('\t\tPoseNode:  {');
    p(`\t\t\tNode: ${ID.mesh}`);
    p('\t\t\tMatrix: *16 {');
    p('\t\t\t\ta: 1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1');
    p('\t\t\t}');
    p('\t\t}');
    bones.forEach((b, i) => {
      const m = bindMatrices.subarray ? bindMatrices.subarray(i * 16, i * 16 + 16) : bindMatrices.slice(i * 16, i * 16 + 16);
      p('\t\tPoseNode:  {');
      p(`\t\t\tNode: ${ID.bone(i)}`);
      p('\t\t\tMatrix: *16 {');
      p(`\t\t\t\ta: ${_arr(m)}`);
      p('\t\t\t}');
      p('\t\t}');
    });
    p('\t}');
  }
  p('}');

  // ── connections ───────────────────────────────────────────────────────────
  p('Connections:  {');
  p(`\tC: "OO",${ID.mesh},0`);
  p(`\tC: "OO",${ID.geom},${ID.mesh}`);
  p(`\tC: "OO",${ID.mat},${ID.mesh}`);
  bones.forEach((b, i) => {
    p(`\tC: "OO",${ID.bone(i)},${b.parent >= 0 ? ID.bone(b.parent) : 0}`);
    p(`\tC: "OO",${ID.attr(i)},${ID.bone(i)}`);
  });
  p(`\tC: "OO",${ID.skin},${ID.geom}`);
  for (const i of clusterBones) {
    p(`\tC: "OO",${ID.cluster(i)},${ID.skin}`);
    p(`\tC: "OO",${ID.bone(i)},${ID.cluster(i)}`);
  }
  p('}');
  p('Takes:  {');
  p('\tCurrent: ""');
  p('}');
  return L.join('\n') + '\n';
}

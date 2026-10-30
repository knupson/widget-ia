function unpackLevelDbWal(buf) {
  const BLOCK_SIZE = 32768;
  const records = [];
  let current = [];
  let offset = 0;
  while (offset < buf.length) {
    const blockEnd = Math.min(offset + BLOCK_SIZE, buf.length);
    let pos = offset;
    while (pos + 7 <= blockEnd) {
      const len = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      if (type === 0 || type > 4 || pos + 7 + len > blockEnd) break;
      const chunk = buf.subarray(pos + 7, pos + 7 + len);
      if (type === 1) {
        records.push(chunk);
        current = [];
      } else if (type === 2) {
        current = [chunk];
      } else if (type === 3 && current.length > 0) {
        current.push(chunk);
      } else if (type === 4 && current.length > 0) {
        current.push(chunk);
        records.push(Buffer.concat(current));
        current = [];
      }
      pos += 7 + len;
    }
    offset += BLOCK_SIZE;
  }
  return records;
}


module.exports = { unpackLevelDbWal };

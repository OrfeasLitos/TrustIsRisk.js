// @flow
function waitForTX(input : bcoin$TX | Hash) : void {
  if (Buffer.isBuffer(input)) {
    const tx : Hash = input
  } else {
    const tx : bcoin$TX = input
  }
}

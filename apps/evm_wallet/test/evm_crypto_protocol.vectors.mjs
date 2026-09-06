// Regenerate independent protocol vectors with the installed pinned release dependencies.
import {keccak256, hashMessage, serializeTransaction, parseTransaction, toRlp} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import fs from 'node:fs';
const out=[];
out.push('import Blob "mo:core/Blob";\nimport Hex "../backend/evm/Hex";\nimport Keccak "../backend/evm/Keccak";\nimport Personal "../backend/evm/Personal";\nimport Rlp "../backend/evm/Rlp";\nimport Transaction "../backend/evm/Transaction";\nimport Debug "mo:core/Debug";\nimport Runtime "mo:core/Runtime";\n');
out.push('func bytes(s : Text) : Blob { switch (Hex.decode(s)) { case (#ok(b)) b; case (#err(e)) Runtime.trap(e) } };\nfunc ok<T>(r : {#ok:T;#err:Text}) : T { switch(r) {case (#ok(v)) v; case (#err(e)) Runtime.trap(e)} };\nfunc fails<T>(r : {#ok:T;#err:Text}) : Bool {switch(r) {case (#err(_)) true; case _ false}};\n');
out.push('// Expected bytes generated independently using viem 2.55.1 / noble, plus published EIP-155 vector.\n');
for(const n of [0,1,2,31,32,55,56,135,136,137,271,272,273,1024]) {
 const hex='0x'+Buffer.from(Array.from({length:n},(_,i)=>(i*197+n*13)%256)).toString('hex');
 out.push(`assert Hex.encode(Keccak.hash(bytes("${hex}"))) == "${keccak256(hex)}";\n`);
 out.push(`assert Hex.encode(Personal.hash(bytes("${hex}"))) == "${hashMessage({raw:hex})}";\n`);
 if(n<=56)out.push(`assert Hex.encode(Rlp.encode(#bytes(bytes("${hex}")))) == "${toRlp(hex)}";\n`);
}
for(const vals of [[],['0x'],['0x','0x01','0x7f','0x80'],['0x'+('a0'.repeat(56)),['0x','0xbeef']],['0x'+('c0'.repeat(256))]]) {
 const literal = x=>Array.isArray(x)?`#list([${x.map(literal)}])`:`#bytes(bytes("${x}"))`;
 out.push(`assert Hex.encode(Rlp.encode(${literal(vals)})) == "${toRlp(vals)}";\n`);
}
const account=privateKeyToAccount('0x'+'46'.repeat(32));
const txs=[
 {type:'legacy',chainId:1,nonce:9,gasPrice:20000000000n,gas:21000n,to:'0x'+'35'.repeat(20),value:10n**18n,data:'0x'},
 {type:'eip1559',chainId:42161,nonce:0,maxFeePerGas:100000000n,maxPriorityFeePerGas:1000000n,gas:28000n,to:'0x'+'ab'.repeat(20),value:0n,data:'0x000102ff',accessList:[]},
 {type:'eip1559',chainId:11155111,nonce:127,maxFeePerGas:1234567890123456n,maxPriorityFeePerGas:234567890n,gas:100000n,value:33n,data:'0x6001600055',accessList:[{address:'0x'+'12'.repeat(20),storageKeys:['0x'+'00'.repeat(32),'0x'+'ff'.repeat(32)]},{address:'0x'+'45'.repeat(20),storageKeys:[]}]},
 {type:'legacy',chainId:8453,nonce:128,gasPrice:1n,gas:53000n,value:0n,data:'0x60016000'},
];
for(let i=0;i<txs.length;i++){
 const tx=txs[i],unsigned=serializeTransaction(tx),signed=await account.signTransaction(tx),fee=tx.type==='legacy'?`#legacy({gasPrice=${tx.gasPrice}})`:`#eip1559({maxFeePerGas=${tx.maxFeePerGas};maxPriorityFeePerGas=${tx.maxPriorityFeePerGas}})`;
 const access='['+(tx.accessList??[]).map(x=>`{address="${x.address}";storageKeys=[${x.storageKeys.map(y=>`"${y}"`)}]}`).join(',')+']';
 out.push(`let tx${i} : Transaction.Transaction = {chainId=${tx.chainId};nonce=${tx.nonce};gasLimit=${tx.gas};to=${tx.to?'?"'+tx.to+'"':'null'};value=${tx.value};data=bytes("${tx.data}");accessList=${access};fee=${fee}};\n`);
 out.push(`assert Hex.encode(ok(Transaction.signingPayload(tx${i}))) == "${unsigned}";\nassert Hex.encode(ok(Transaction.signingHash(tx${i}))) == "${keccak256(unsigned)}";\n`);
 const p=parseTransaction(signed), parity= p.yParity ?? Number((p.v-35n-BigInt(tx.chainId)*2n));
 out.push(`let signed${i}=ok(Transaction.signed(tx${i},{r=${BigInt(p.r)};s=${BigInt(p.s)};yParity=${parity}}));\nassert Hex.encode(signed${i}.raw) == "${signed}";\nassert Hex.encode(signed${i}.hash) == "${keccak256(signed)}";\n`);
}
out.push(`assert Hex.encode(Hex.nat(0)) == "0x";
assert Hex.encode(Hex.nat(0xabcdef)) == "0xabcdef";
assert Hex.toNat(bytes("0xabcd")) == 0xabcd;
assert ok(Hex.parseNat("0xAbCd")) == 0xabcd;
assert ok(Hex.parseNat("115792089237316195423570985008687907853269984665640564039457584007913129639935")) == Hex.uint256Limit - 1;
assert Hex.encode(ok(Hex.word(1))) == "0x${'0'.repeat(63)}1";
assert fails(Hex.word(Hex.uint256Limit));
for(input in ["", "0X01", "0x0", "0xgg", "01", " 0x00"].vals()) assert fails(Hex.decode(input));
for(input in ["", "-1", "+1", "0x", "1.0", "1e2", "12A", " 1", "1 "].vals()) assert fails(Hex.parseNat(input));
assert fails(Transaction.signingPayload({tx0 with value=Hex.uint256Limit}));
assert fails(Transaction.signingPayload({tx0 with nonce=0xffffffffffffffff}));
assert fails(Transaction.signingPayload({tx0 with gasLimit=0x10000000000000000}));
assert fails(Transaction.signingPayload({tx0 with to=?"0x1234"}));
assert fails(Transaction.signingPayload({tx0 with accessList=[{address="0x${'12'.repeat(20)}";storageKeys=[]}]}));
assert fails(Transaction.signingPayload({tx1 with fee=#eip1559({maxFeePerGas=1;maxPriorityFeePerGas=2})}));
assert fails(Transaction.signingPayload({tx1 with accessList=[{address="0x${'12'.repeat(20)}";storageKeys=["0x00"]}]}));
assert fails(Transaction.signed(tx0,{r=0;s=1;yParity=0}));
assert fails(Transaction.signed(tx0,{r=1;s=1;yParity=2}));
assert fails(Transaction.signed(tx0,{r=1;s=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141/2+1;yParity=0}));
Debug.print("Protocol vectors passed");
`);
const target=new URL('./evm_crypto_protocol_test.mo',import.meta.url);
if(process.argv.includes('--check')) {
 if(fs.readFileSync(target,'utf8')!==out.join(''))throw new Error('Protocol vectors differ; regenerate them');
} else fs.writeFileSync(target,out.join(''));

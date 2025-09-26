const { ethers } = require('ethers');
const fs = require('fs');

async function deployFlashloanArbitrage() {
    const provider = new ethers.JsonRpcProvider("https://mainnet.infura.io/v3/YOUR_INFURA_KEY");
    const wallet = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);

    // AAVE V3 Pool Addresses Provider (Mainnet)
    const poolAddressesProvider = "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e";

    // 读取编译好的合约
    const contractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/FlashloanArbitrage.sol/FlashloanArbitrage.json', 'utf8'));

    const contractFactory = new ethers.ContractFactory(
        contractJson.abi,
        contractJson.bytecode,
        wallet
    );

    console.log("部署闪电贷套利合约...");
    const contract = await contractFactory.deploy(poolAddressesProvider);
    await contract.waitForDeployment();

    console.log(`合约已部署到: ${await contract.getAddress()}`);

    // 设置授权调用者
    await contract.setAuthorizedCaller(wallet.address, true);
    console.log("已设置授权调用者");

    return await contract.getAddress();
}

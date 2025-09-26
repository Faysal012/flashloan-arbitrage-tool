const FlashloanArbitrageBot = require('./src/ArbitrageBot');

async function main() {
    // 部署合约（仅需要执行一次）
    // const contractAddress = await deployFlashloanArbitrage();

    const contractAddress = "YOUR_DEPLOYED_CONTRACT_ADDRESS";

    const bot = new FlashloanArbitrageBot(
        "https://mainnet.infura.io/v3/YOUR_INFURA_KEY",
        "YOUR_PRIVATE_KEY",
        contractAddress
    );

    // 单次扫描
    console.log("=== 单次套利机会扫描 ===");
    const opportunities = await bot.scanForArbitrageOpportunities();
    
    if (opportunities.length > 0) {
        console.log("发现的套利机会:");
        opportunities.slice(0, 5).forEach((opp, index) => {
            console.log(`${index + 1}. ${bot.getTokenSymbol(opp.tokenA)}-${bot.getTokenSymbol(opp.tokenB)}`);
            console.log(`   DEX路径: ${opp.dexAName} -> ${opp.dexBName}`);
            console.log(`   预期利润: ${opp.profitInEth} ETH`);
            console.log("");
        });

        // 执行最佳机会（如果有利可图）
        const bestOpp = opportunities[0];
        if (parseFloat(bestOpp.profitInEth) > 0.01) {
            console.log("执行最佳套利机会...");
            const result = await bot.executeArbitrage(bestOpp);
            console.log("执行结果:", result);
        }
    } else {
        console.log("未发现有利可图的套利机会");
    }

    // 启动持续监控（可选）
    // await bot.monitorAndExecute(30000); // 每30秒检查一次
}

main().catch(console.error);

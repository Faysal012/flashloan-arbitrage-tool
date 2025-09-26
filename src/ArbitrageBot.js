const { ethers } = require('ethers');
const axios = require('axios');

class FlashloanArbitrageBot {
    constructor(provider, walletPrivateKey, contractAddress) {
        this.provider = new ethers.JsonRpcProvider(provider);
        this.wallet = new ethers.Wallet(walletPrivateKey, this.provider);
        this.contractAddress = contractAddress;
        
        // DEX路由合约地址
        this.dexRouters = {
            uniswapV2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
            uniswapV3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
            sushiswap: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
            pancakeswap: "0x10ED43C718714eb63d5aA57B78B54704E256024E" // BSC
        };
        
        // 常用代币地址
        this.tokens = {
            WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            USDC: "0xA0b86a33E6441b0b5C4C1B89DfC2FbB4e0A0b26D",
            USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F"
        };
this.minProfitThreshold = ethers.parseEther("0.01"); // 最小利润0.01 ETH
        this.maxGasPrice = ethers.parseUnits("50", "gwei");
        
        // 合约ABI
        this.contractABI = [
            "function executeArbitrage((address,address,address,address,uint24,uint24,uint256,bool,bool)) external",
            "function estimateArbitrageProfit((address,address,address,address,uint24,uint24,uint256,bool,bool)) external view returns (uint256, bool)",
            "event ArbitrageExecuted(address indexed tokenA, address indexed tokenB, uint256 amountIn, uint256 profit)"
        ];
        
        this.contract = new ethers.Contract(contractAddress, this.contractABI, this.wallet);
    }

    async scanForArbitrageOpportunities(tokenPairs = null) {
        console.log("扫描套利机会...");
        
        if (!tokenPairs) {
            tokenPairs = [
                [this.tokens.WETH, this.tokens.USDC],
                [this.tokens.WETH, this.tokens.USDT],
                [this.tokens.USDC, this.tokens.USDT],
                [this.tokens.USDC, this.tokens.DAI],
                [this.tokens.WETH, this.tokens.DAI]
            ];
        }

        const opportunities = [];

        for (const [tokenA, tokenB] of tokenPairs) {
            try {
                // 检查不同DEX之间的价格差异
                const dexPairs = [
                    { dexA: this.dexRouters.uniswapV2, dexB: this.dexRouters.sushiswap, useV3A: false, useV3B: false },
                    { dexA: this.dexRouters.uniswapV3, dexB: this.dexRouters.uniswapV2, useV3A: true, useV3B: false },
                    { dexA: this.dexRouters.uniswapV2, dexB: this.dexRouters.uniswapV3, useV3A: false, useV3B: true },
                    { dexA: this.dexRouters.sushiswap, dexB: this.dexRouters.uniswapV3, useV3A: false, useV3B: true }
                ];

                for (const dexPair of dexPairs) {
                    const opportunity = await this.checkArbitrageOpportunity(
                        tokenA, tokenB, dexPair, ethers.parseEther("1")
                    );
                    
                    if (opportunity.profitable) {
                        opportunities.push(opportunity);
                    }
                }
            } catch (error) {
                console.error(`检查 ${tokenA}-${tokenB} 套利机会失败:`, error.message);
            }
        }

        return opportunities.sort((a, b) => b.estimatedProfit - a.estimatedProfit);
    }

    async checkArbitrageOpportunity(tokenA, tokenB, dexPair, amount) {
        const params = {
            tokenA: tokenA,
            tokenB: tokenB,
            dexA: dexPair.dexA,
            dexB: dexPair.dexB,
            feeA: 3000, // 0.3% for V3, ignored for V2
            feeB: 3000,
            amountIn: amount,
            useV3A: dexPair.useV3A,
            useV3B: dexPair.useV3B
        };

        try {
            const [estimatedProfit, profitable] = await this.contract.estimateArbitrageProfit(params);
            
            return {
                tokenA,
                tokenB,
                params,
                estimatedProfit: estimatedProfit,
                profitable: profitable,
                profitInEth: ethers.formatEther(estimatedProfit),
                dexAName: this.getDexName(dexPair.dexA),
                dexBName: this.getDexName(dexPair.dexB)
            };
        } catch (error) {
            console.error("预估套利收益失败:", error.message);
            return { profitable: false, estimatedProfit: 0 };
        }
    }

    async executeArbitrage(opportunity) {
        console.log(`执行套利: ${this.getTokenSymbol(opportunity.tokenA)}-${this.getTokenSymbol(opportunity.tokenB)}`);
        console.log(`预期利润: ${opportunity.profitInEth} ETH`);

        try {
            // 检查gas价格
            const feeData = await this.provider.getFeeData();
            if (feeData.gasPrice && feeData.gasPrice > this.maxGasPrice) {
                console.log("Gas价格过高，跳过执行");
                return null;
            }

            // 估算gas费用
            const gasEstimate = await this.contract.executeArbitrage.estimateGas(opportunity.params);
            const gasCost = gasEstimate * feeData.gasPrice;
            
            console.log(`预估Gas费用: ${ethers.formatEther(gasCost)} ETH`);

            // 检查是否仍然有利可图
            if (opportunity.estimatedProfit <= gasCost) {
                console.log("扣除Gas费用后无利可图，跳过执行");
                return null;
            }

            // 执行套利交易
            const tx = await this.contract.executeArbitrage(opportunity.params, {
                gasLimit: gasEstimate.mul(120).div(100), // 增加20%的gas限制
                gasPrice: feeData.gasPrice
            });

            console.log(`套利交易已发送: ${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`套利交易已确认: ${receipt.transactionHash}`);

            // 解析事件获取实际利润
            const arbitrageEvent = receipt.events?.find(e => e.event === 'ArbitrageExecuted');
            if (arbitrageEvent) {
                const actualProfit = arbitrageEvent.args.profit;
                console.log(`实际利润: ${ethers.formatEther(actualProfit)} ETH`);
            }

            return {
                success: true,
                txHash: receipt.transactionHash,
                gasUsed: receipt.gasUsed,
                actualProfit: arbitrageEvent?.args.profit || 0
            };

        } catch (error) {
            console.error("执行套利失败:", error.message);
            return { success: false, error: error.message };
        }
    }

    async monitorAndExecute(intervalMs = 10000) {
        console.log("开始监控和执行套利...");

        const monitor = async () => {
            try {
                const opportunities = await this.scanForArbitrageOpportunities();
                
                if (opportunities.length > 0) {
                    console.log(`发现 ${opportunities.length} 个套利机会:`);
                    
                    for (let i = 0; i < Math.min(opportunities.length, 3); i++) {
                        const opp = opportunities[i];
                        console.log(`${i+1}. ${this.getTokenSymbol(opp.tokenA)}-${this.getTokenSymbol(opp.tokenB)}: ${opp.profitInEth} ETH`);
                    }

                    // 执行最有利的机会
                    const bestOpportunity = opportunities[0];
                    if (parseFloat(bestOpportunity.profitInEth) > 0.01) { // 最小利润阈值
                        await this.executeArbitrage(bestOpportunity);
                    }
                } else {
                    console.log("未发现有利可图的套利机会");
                }
            } catch (error) {
                console.error("监控过程中出错:", error.message);
            }
        };

        // 立即执行一次
        await monitor();
        
        // 设置定时监控
        setInterval(monitor, intervalMs);
    }

    getDexName(address) {
        const addressMap = {
            [this.dexRouters.uniswapV2]: "Uniswap V2",
            [this.dexRouters.uniswapV3]: "Uniswap V3",
            [this.dexRouters.sushiswap]: "SushiSwap"
        };
        return addressMap[address] || "Unknown DEX";
    }

    getTokenSymbol(address) {
        const symbolMap = {
            [this.tokens.WETH]: "WETH",
            [this.tokens.USDC]: "USDC",
            [this.tokens.USDT]: "USDT",
            [this.tokens.DAI]: "DAI"
        };
        return symbolMap[address] || address.slice(0, 6);
    }

    // 获取代币价格（用于验证）
    async getTokenPrice(tokenAddress) {
        try {
            const response = await axios.get(
                `https://api.coingecko.com/api/v3/simple/token_price/ethereum`,
                {
                    params: {
                        contract_addresses: tokenAddress,
                        vs_currencies: 'usd'
                    }
                }
            );
            return response.data[tokenAddress.toLowerCase()]?.usd || 0;
        } catch (error) {
            console.error("获取代币价格失败:", error.message);
            return 0;
        }
    }

    // 风险管理
    async checkRiskParameters() {
        const balance = await this.provider.getBalance(this.wallet.address);
        const minBalance = ethers.parseEther("0.1"); // 最小余额0.1 ETH

        if (balance < minBalance) {
            console.warn("钱包余额不足，停止套利");
            return false;
        }

        return true;
    }
}

pragma solidity ^0.8.0;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
    
    function getAmountsOut(uint amountIn, address[] calldata path)
        external view returns (uint[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

contract FlashloanArbitrage is FlashLoanSimpleReceiverBase, Ownable {
    
    struct ArbitrageParams {
        address tokenA;
        address tokenB;
        address dexA; // 买入的DEX
        address dexB; // 卖出的DEX
        uint24 feeA;  // Uniswap V3 fee tier
        uint24 feeB;
        uint256 amountIn;
        bool useV3A;  // DEX A 是否为 Uniswap V3
        bool useV3B;  // DEX B 是否为 Uniswap V3
    }
    
    mapping(address => bool) public authorizedCallers;
    
    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountIn,
        uint256 profit
    );
    
    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }
    
    constructor(address _poolAddressesProvider) 
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_poolAddressesProvider)) 
    {}
    
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }
    
    function executeArbitrage(ArbitrageParams calldata params) external onlyAuthorized {
        bytes memory data = abi.encode(params);
        
        POOL.flashLoanSimple(
            address(this),
            params.tokenA,
            params.amountIn,
            data,
            0 // referralCode
        );
    }
    
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Caller must be AAVE pool");
        
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));
        
        // 执行套利逻辑
        uint256 profit = _performArbitrage(arbParams);
        
        // 确保有足够的资金偿还闪电贷
        uint256 amountOwed = amount + premium;
        require(profit > premium, "Arbitrage not profitable");
        
        // 授权AAVE池子扣除还款金额
        IERC20(asset).approve(address(POOL), amountOwed);
        
        emit ArbitrageExecuted(arbParams.tokenA, arbParams.tokenB, amount, profit - premium);
        
        return true;
    }
    
    function _performArbitrage(ArbitrageParams memory params) internal returns (uint256) {
        uint256 initialBalance = IERC20(params.tokenA).balanceOf(address(this));
        
        // 第一步: 在DEX A买入tokenB
        uint256 tokenBAmount = _swapOnDex(
            params.tokenA,
            params.tokenB,
            params.amountIn,
            params.dexA,
            params.feeA,
            params.useV3A
        );
        
        // 第二步: 在DEX B卖出tokenB换回tokenA
        uint256 finalTokenAAmount = _swapOnDex(
            params.tokenB,
            params.tokenA,
            tokenBAmount,
            params.dexB,
            params.feeB,
            params.useV3B
        );
        
        uint256 finalBalance = IERC20(params.tokenA).balanceOf(address(this));
        uint256 profit = finalBalance - initialBalance;
        
        return profit;
    }
    
    function _swapOnDex(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address dexRouter,
        uint24 fee,
        bool useV3
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(dexRouter, amountIn);
        
        if (useV3) {
            // Uniswap V3 swap
            IUniswapV3Router.ExactInputSingleParams memory swapParams = IUniswapV3Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: 0, // 在实际使用中应该设置合理的滑点保护
                sqrtPriceLimitX96: 0
            });
            
            return IUniswapV3Router(dexRouter).exactInputSingle(swapParams);
        } else {
            // Uniswap V2 style swap
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            
            uint[] memory amounts = IUniswapV2Router(dexRouter).swapExactTokensForTokens(
                amountIn,
                0, // 在实际使用中应该设置合理的滑点保护
                path,
                address(this),
                block.timestamp + 300
            );
            
            return amounts[amounts.length - 1];
        }
    }
    
    // 预估套利收益
    function estimateArbitrageProfit(ArbitrageParams calldata params) 
        external view returns (uint256 estimatedProfit, bool profitable) {
        
        // 获取DEX A的输出金额
        uint256 tokenBAmount = _getAmountOut(
            params.tokenA,
            params.tokenB,
            params.amountIn,
            params.dexA,
            params.feeA,
            params.useV3A
        );
        
        // 获取DEX B的输出金额
        uint256 finalTokenAAmount = _getAmountOut(
            params.tokenB,
            params.tokenA,
            tokenBAmount,
            params.dexB,
            params.feeB,
            params.useV3B
        );
        
        if (finalTokenAAmount > params.amountIn) {
            estimatedProfit = finalTokenAAmount - params.amountIn;
            
            // 考虑闪电贷手续费（AAVE大约0.09%）
            uint256 flashloanFee = params.amountIn * 9 / 10000;
            profitable = estimatedProfit > flashloanFee;
            estimatedProfit = profitable ? estimatedProfit - flashloanFee : 0;
        } else {
            estimatedProfit = 0;
            profitable = false;
        }
    }
    
    function _getAmountOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address dexRouter,
        uint24 fee,
        bool useV3
    ) internal view returns (uint256) {
        if (useV3) {
            // 对于Uniswap V3，需要实现更复杂的价格计算
            // 这里简化处理，实际应该调用Quoter合约
            return amountIn; // 占位符
        } else {
            // Uniswap V2 style
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            
            try IUniswapV2Router(dexRouter).getAmountsOut(amountIn, path) returns (uint[] memory amounts) {
                return amounts[amounts.length - 1];
            } catch {
                return 0;
            }
        }
    }
    
    // 紧急提取函数
    function emergencyWithdraw(address token) external onlyOwner {
        IERC20 tokenContract = IERC20(token);
        uint256 balance = tokenContract.balanceOf(address(this));
        tokenContract.transfer(owner(), balance);
    }
    
    // 提取ETH
    function withdrawETH() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }
    
    receive() external payable {}
}

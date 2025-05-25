import "dotenv/config";
import { ethers } from "ethers";

// =========================================================================
// KONFIGURASI & KONSTANTA
// =========================================================================
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const ETH_ADDRESS = process.env.ETH_ADDRESS;
const BTC_ADDRESS = process.env.BTC_ADDRESS;
const NETWORK_NAME = process.env.NETWORK_NAME || "0G Newton Testnet";
const APPROVAL_GAS_LIMIT = 100000;
const SWAP_GAS_LIMIT = 150000;

// =========================================================================
// SETUP ETHERS & WALLET
// =========================================================================
if (!RPC_URL || !PRIVATE_KEY || !ROUTER_ADDRESS || !USDT_ADDRESS || !ETH_ADDRESS || !BTC_ADDRESS) {
    console.error("❌ Error: Pastikan semua variabel .env (RPC_URL, PRIVATE_KEY, ROUTER_ADDRESS, USDT_ADDRESS, ETH_ADDRESS, BTC_ADDRESS) sudah diisi.");
    process.exit(1);
}
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// =========================================================================
// LOGGER SEDERHANA
// =========================================================================
const colors = { reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", white: "\x1b[37m" };
const logger = {
    info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
    warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
    progress: (msg) => console.log(`${colors.cyan}[⏳] ${msg}${colors.reset}`),
    step: (msg) => console.log(`\n${colors.white}--- ${msg} ---${colors.reset}`),
};

// =========================================================================
// ABIs (Disederhanakan + Router)
// =========================================================================
const ERC20_ABI = [
    { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_spender", type: "address" }, { name: "_value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }, { name: "_spender", type: "address" }], outputs: [{ name: "remaining", type: "uint256" }] }
];
const ROUTER_ABI = [
    { inputs: [{ components: [ { internalType: "address", name: "tokenIn", type: "address" }, { internalType: "address", name: "tokenOut", type: "address" }, { internalType: "uint24", name: "fee", type: "uint24" }, { internalType: "address", name: "recipient", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }, { internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMinimum", type: "uint256" }, { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }, ], internalType: "struct ISwapRouter.ExactInputSingleParams", name: "params", type: "tuple", }, ], name: "exactInputSingle", outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }], stateMutability: "payable", type: "function", },
];

// =========================================================================
// STATE & UTILITIES
// =========================================================================
let transactionQueue = Promise.resolve();
let nextNonce = null;
let selectedGasOptions = {};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const shortHash = (hash) => `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`;
const timestamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

// =========================================================================
// FUNGSI INTI
// =========================================================================
async function updateWalletData() {
    try {
        const walletAddress = wallet.address;
        const balanceNative = await provider.getBalance(walletAddress);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const balanceUSDT = await usdtContract.balanceOf(walletAddress);
        const ethContract = new ethers.Contract(ETH_ADDRESS, ERC20_ABI, provider);
        const balanceETH = await ethContract.balanceOf(walletAddress);
        const btcContract = new ethers.Contract(BTC_ADDRESS, ERC20_ABI, provider);
        const balanceBTC = await btcContract.balanceOf(walletAddress);

        logger.info(`[${timestamp()}] Wallet: ${walletAddress}`);
        logger.info(`  AOGI : ${parseFloat(ethers.formatEther(balanceNative)).toFixed(4)}`);
        logger.info(`  ETH  : ${parseFloat(ethers.formatEther(balanceETH)).toFixed(4)}`);
        logger.info(`  USDT : ${parseFloat(ethers.formatUnits(balanceUSDT, 18)).toFixed(4)}`);
        logger.info(`  BTC  : ${parseFloat(ethers.formatUnits(balanceBTC, 18)).toFixed(4)}`);
    } catch (error) {
        logger.error(`[${timestamp()}] Gagal mengambil data wallet: ${error.message}`);
    }
}

async function approveToken(tokenAddress, amount, nonceForApproval) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        logger.info(`  [${timestamp()}] Mengirim approval untuk ${ethers.formatUnits(amount, 18)} token...`);
        const tx = await tokenContract.approve(ROUTER_ADDRESS, amount, {
            gasLimit: APPROVAL_GAS_LIMIT,
            ...selectedGasOptions,
            nonce: nonceForApproval
        });
        logger.progress(`  [${timestamp()}] Approval Tx Dikirim: ${shortHash(tx.hash)} (Nonce: ${nonceForApproval})`);
        await tx.wait();
        logger.info(`  [${timestamp()}] Approval berhasil (Nonce: ${nonceForApproval}).`);
        return true;
    } catch (error) {
        logger.error(`  [${timestamp()}] Approval gagal (Nonce: ${nonceForApproval}): ${error.message}`);
        return false;
    }
}

async function swapAuto(direction, amountIn, nonceForSwap) {
    try {
        const swapContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
        const deadline = Math.floor(Date.now() / 1000) + 120; 
        let params;
        let tokenInAddress, tokenOutAddress, tokenInName, tokenOutName;

        switch (direction) {
            case "usdtToEth": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [USDT_ADDRESS, ETH_ADDRESS, 'USDT', 'ETH']; break;
            case "ethToUsdt": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [ETH_ADDRESS, USDT_ADDRESS, 'ETH', 'USDT']; break;
            case "usdtToBtc": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [USDT_ADDRESS, BTC_ADDRESS, 'USDT', 'BTC']; break;
            case "btcToUsdt": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [BTC_ADDRESS, USDT_ADDRESS, 'BTC', 'USDT']; break;
            case "btcToEth": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [BTC_ADDRESS, ETH_ADDRESS, 'BTC', 'ETH']; break;
            case "ethToBtc": [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [ETH_ADDRESS, BTC_ADDRESS, 'ETH', 'BTC']; break;
            default: throw new Error(`Arah swap tidak dikenal: ${direction}`);
        }

        logger.info(`  [${timestamp()}] Memulai Swap ${tokenInName} ➯ ${tokenOutName} (${ethers.formatUnits(amountIn, 18)} ${tokenInName})`);
        
        params = {
            tokenIn: tokenInAddress, tokenOut: tokenOutAddress, fee: 3000, 
            recipient: wallet.address, deadline, amountIn, 
            amountOutMinimum: 0, sqrtPriceLimitX96: 0n,
        };

        const tx = await swapContract.exactInputSingle(params, {
            gasLimit: SWAP_GAS_LIMIT,
            ...selectedGasOptions, 
            nonce: nonceForSwap 
        });
        logger.progress(`  [${timestamp()}] Swap Tx Dikirim: ${shortHash(tx.hash)} (Nonce: ${nonceForSwap})`);
        const receipt = await tx.wait();
        const effectiveGasPrice = receipt.gasPrice || selectedGasOptions.gasPrice || selectedGasOptions.maxFeePerGas || ethers.parseUnits("1", "gwei");
        const feeAOGI = ethers.formatEther(receipt.gasUsed * effectiveGasPrice);
        logger.info(`  [${timestamp()}] Swap Tx Berhasil: ${shortHash(tx.hash)} (Nonce: ${nonceForSwap}) | Fee: ${feeAOGI} AOGI`);
        return true;

    } catch (error) {
        logger.error(`  [${timestamp()}] Swap ${direction} gagal (Nonce: ${nonceForSwap}): ${error.message}`);
        if (error.message && error.message.toLowerCase().includes("nonce")) {
            logger.warn(`  [${timestamp()}] Terdeteksi error nonce pada swap, mencoba refresh nonce global...`);
            nextNonce = null; 
        }
        return false; 
    }
}

function addTransactionToQueue(transactionFunction, description) {
    transactionQueue = transactionQueue.then(async () => {
        logger.progress(`[${timestamp()}] Memproses: ${description}`);
        try {
            if (nextNonce === null) {
                nextNonce = await provider.getTransactionCount(wallet.address, "pending");
                logger.info(`[${timestamp()}] Nonce saat ini: ${nextNonce}`);
            }
            const success = await transactionFunction(nextNonce);
            if (success) {
                nextNonce++;
            } else {
                // Jika transaksi (approve atau swap) gagal, kita mungkin ingin mereset nonce
                // agar diambil ulang, atau membiarkannya untuk coba lagi nonce yang sama
                // pada item antrean berikutnya jika errornya bukan karena nonce (misal, revert).
                // Untuk sekarang, reset jika gagal agar fresh.
                logger.warn(`[${timestamp()}] Transaksi "${description}" gagal, nonce akan di-refresh untuk tugas berikutnya.`);
                nextNonce = null;
            }
            return success;
        } catch (error) {
            logger.error(`[${timestamp()}] Error dalam antrean [${description}]: ${error.message}`);
            nextNonce = null; 
            return false;
        }
    }).catch(err => {
        logger.error(`[${timestamp()}] Error fatal di rantai Promise: ${err.message}`);
        nextNonce = null;
        return false; 
    });
    return transactionQueue;
}

async function runSwapSequence(pairName, directionA, directionB, totalSwaps, amountA, amountB, tokenAAddr, tokenBAddr) {
    logger.step(`Memulai Sequence Swap ${pairName} (${totalSwaps}x)`);
    let successCount = 0;
    let failureCount = 0;

    for (let i = 1; i <= totalSwaps; i++) {
        const direction = (i % 2 === 1) ? directionA : directionB;
        const amount = (i % 2 === 1) ? amountA : amountB;
        const tokenAddr = (i % 2 === 1) ? tokenAAddr : tokenBAddr; 
        const tokenInName = direction.split("To")[0].toUpperCase();

        logger.info(`[${timestamp()}] [${pairName}] Swap ke-${i}/${totalSwaps} | Arah: ${direction}`);
        
        const tokenInContractForBalance = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
        const currentBalance = await tokenInContractForBalance.balanceOf(wallet.address);
        if (currentBalance < amount) {
            logger.warn(`  [${timestamp()}] Saldo ${tokenInName} (${ethers.formatUnits(currentBalance, 18)}) tidak cukup. Melewati swap.`);
            failureCount++;
        } else {
            const tokenInContractForApproval = new ethers.Contract(tokenAddr, ERC20_ABI, wallet); // Gunakan wallet untuk allowance
            const currentAllowance = await tokenInContractForApproval.allowance(wallet.address, ROUTER_ADDRESS);
            
            let approvalProcessedSuccessfully = true;
            if (currentAllowance < amount) {
                logger.info(`  [${timestamp()}] Approval diperlukan untuk ${tokenInName}.`);
                approvalProcessedSuccessfully = await addTransactionToQueue(
                    (nonce) => approveToken(tokenAddr, amount, nonce),
                    `${pairName} - Approve ${tokenInName} ${i}`
                );
                if (approvalProcessedSuccessfully) {
                    await delay(3000); // Jeda singkat setelah approval berhasil sebelum swap
                }
            } else {
                logger.info(`  [${timestamp()}] Approval sudah ada untuk ${tokenInName}.`);
            }

            if (approvalProcessedSuccessfully) {
                const swapSuccess = await addTransactionToQueue(
                    (nonce) => swapAuto(direction, amount, nonce),
                    `${pairName} - Swap ${tokenInName} ${i}`
                );
                if (swapSuccess) successCount++;
                else failureCount++;
            } else {
                logger.warn(`  [${timestamp()}] Approval gagal, swap dilewati untuk ${tokenInName}.`);
                failureCount++;
            }
        }

        if (i < totalSwaps) {
            const delaySeconds = Math.floor(Math.random() * (10 - 5 + 1)) + 5; 
            logger.progress(`  [${timestamp()}] Menunggu ${delaySeconds} detik...`);
            await delay(delaySeconds * 1000);
        }
    }
    logger.info(`[${timestamp()}] Sequence Swap ${pairName} Selesai. Berhasil: ${successCount}, Gagal: ${failureCount}`);
    return { success: successCount, failure: failureCount };
}

// =========================================================================
// FUNGSI MAIN (NON-TUI)
// =========================================================================
async function main() {
    console.log("=============================================");
    console.log("     0G LABS AUTO SWAP BOT (Konsol)     ");
    console.log("=============================================");

    try {
        const SWAPS_PER_PAIR = 5; 
        const USDT_SWAP_AMOUNT = ethers.parseUnits("100", 18); 
        const ETH_SWAP_AMOUNT = ethers.parseUnits("0.03", 18); 
        const BTC_SWAP_AMOUNT = ethers.parseUnits("0.003", 18); 

        logger.info(`[${timestamp()}] Memulai Bot... Network: ${NETWORK_NAME}`);
        await updateWalletData();

        logger.progress(`[${timestamp()}] Mengambil Gas Fee Data...`);
        const feeData = await provider.getFeeData();

        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            selectedGasOptions = {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas, 
            };
            logger.info(`[${timestamp()}] Gas (EIP-1559): MaxFee=${ethers.formatUnits(selectedGasOptions.maxFeePerGas, "gwei")} | PrioFee=${ethers.formatUnits(selectedGasOptions.maxPriorityFeePerGas, "gwei")} Gwei`);
        } else if (feeData.gasPrice) {
            logger.warn(`[${timestamp()}] Jaringan/RPC mungkin tidak mendukung EIP-1559, menggunakan gasPrice legacy.`);
            selectedGasOptions = {
                gasPrice: feeData.gasPrice * 120n / 100n, 
            };
            logger.info(`[${timestamp()}] Gas (Legacy): ${ethers.formatUnits(selectedGasOptions.gasPrice, "gwei")} Gwei`);
        } else {
            logger.error(`[${timestamp()}] Gagal mengambil data fee gas dari provider. Menggunakan nilai default.`);
            selectedGasOptions = {
                gasPrice: ethers.parseUnits("2", "gwei") 
            };
            logger.warn(`[${timestamp()}] Gas (Default): ${ethers.formatUnits(selectedGasOptions.gasPrice, "gwei")} Gwei`);
        }
        
        if (!selectedGasOptions.maxFeePerGas && !selectedGasOptions.gasPrice) {
            throw new Error("Gagal menetapkan opsi gas yang valid.");
        }

        await runSwapSequence("USDT & ETH", "usdtToEth", "ethToUsdt", SWAPS_PER_PAIR, USDT_SWAP_AMOUNT, ETH_SWAP_AMOUNT, USDT_ADDRESS, ETH_ADDRESS);
        await updateWalletData(); 
        await delay(10000); // Jeda antar sequence diperpendek untuk tes

        await runSwapSequence("USDT & BTC", "usdtToBtc", "btcToUsdt", SWAPS_PER_PAIR, USDT_SWAP_AMOUNT, BTC_SWAP_AMOUNT, USDT_ADDRESS, BTC_ADDRESS);
        await updateWalletData(); 
        await delay(10000); // Jeda antar sequence diperpendek untuk tes

        await runSwapSequence("BTC & ETH", "btcToEth", "ethToBtc", SWAPS_PER_PAIR, BTC_SWAP_AMOUNT, ETH_SWAP_AMOUNT, BTC_ADDRESS, ETH_ADDRESS);
        await updateWalletData(); 

        logger.info(`[${timestamp()}] Semua sequence swap telah selesai ditambahkan ke antrean.`);
        logger.progress(`[${timestamp()}] Menunggu semua transaksi di antrean selesai...`);
        
        await transactionQueue; 
        let finalNonceCheck = await provider.getTransactionCount(wallet.address, "pending");
        // UBAH KONDISI DI SINI: dari '>=' menjadi '<'
        while (nextNonce !== null && finalNonceCheck < nextNonce ) { 
             logger.progress(`[${timestamp()}] Menunggu konfirmasi transaksi terakhir... (Nonce jaringan: ${finalNonceCheck}, Target nonce script: ${nextNonce})`);
             await delay(15000); 
             finalNonceCheck = await provider.getTransactionCount(wallet.address, "pending");
        }

        logger.info(`✨✨ [${timestamp()}] SEMUA TRANSAKSI SELESAI! ✨✨`);
        await updateWalletData();
        process.exit(0);

    } catch (error) {
        logger.error(`[${timestamp()}] Terjadi error fatal di main: ${error.message}`);
        console.error(error);
        process.exit(1);
    }
}

main();

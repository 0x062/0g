import "dotenv/config";
import { ethers } from "ethers";
import { sendTelegramNotification } from './telegramReporter.js';

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

const MIN_USDT_BALANCE = ethers.parseUnits(process.env.MIN_USDT_BALANCE || "100", 18); 
const MIN_ETH_BALANCE = ethers.parseUnits(process.env.MIN_ETH_BALANCE || "0.02", 18);  
const MIN_BTC_BALANCE = ethers.parseUnits(process.env.MIN_BTC_BALANCE || "0.0012", 18); 
const MIN_AOGI_BALANCE_FOR_GAS = ethers.parseUnits(process.env.MIN_AOGI_BALANCE_FOR_GAS || "0.000002", 18);

// =========================================================================
// SETUP ETHERS & WALLET
// =========================================================================
if (!RPC_URL || !PRIVATE_KEY || !ROUTER_ADDRESS || !USDT_ADDRESS || !ETH_ADDRESS || !BTC_ADDRESS) {
    console.error("❌ Error: Pastikan semua variabel .env (RPC_URL, PRIVATE_KEY, ROUTER_ADDRESS, USDT_ADDRESS, ETH_ADDRESS, BTC_ADDRESS) sudah diisi.");
    // Tidak bisa kirim telegram di sini karena sendTelegramNotification mungkin belum siap atau butuh env juga
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
    success: (msg) => console.log(`${colors.green}[✔] ${msg}${colors.reset}`),
};

// =========================================================================
// ABIs
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
async function updateWalletData(logFull = true) {
    try {
        const walletAddress = wallet.address;
        const balanceNative = await provider.getBalance(walletAddress);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const balanceUSDT = await usdtContract.balanceOf(walletAddress);
        const ethContract = new ethers.Contract(ETH_ADDRESS, ERC20_ABI, provider);
        const balanceETH = await ethContract.balanceOf(walletAddress);
        const btcContract = new ethers.Contract(BTC_ADDRESS, ERC20_ABI, provider);
        const balanceBTC = await btcContract.balanceOf(walletAddress);

        let report = "";
        if (logFull) {
            const aogiFormatted = parseFloat(ethers.formatEther(balanceNative)).toFixed(4);
            const ethFormatted = parseFloat(ethers.formatEther(balanceETH)).toFixed(4);
            const usdtFormatted = parseFloat(ethers.formatUnits(balanceUSDT, 18)).toFixed(4);
            const btcFormatted = parseFloat(ethers.formatUnits(balanceBTC, 18)).toFixed(4);
            
            report += `[${timestamp()}] Wallet: ${walletAddress}\n`;
            report += `  AOGI : ${aogiFormatted}\n`;
            report += `  ETH  : ${ethFormatted}\n`;
            report += `  USDT : ${usdtFormatted}\n`;
            report += `  BTC  : ${btcFormatted}`;
            logger.info(report.trim());
        }
        return { balanceNative, balanceUSDT, balanceETH, balanceBTC, reportString: report.trim() };
    } catch (error) {
        logger.error(`[${timestamp()}] Gagal mengambil data wallet: ${error.message}`);
        return null;
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
        const normalizedDirection = direction.toLowerCase();

        switch (normalizedDirection) {
            case "usdttousdt": 
            case "usdttoeth": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [USDT_ADDRESS, ETH_ADDRESS, 'USDT', 'ETH']; 
                break;
            case "ethtousdt": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [ETH_ADDRESS, USDT_ADDRESS, 'ETH', 'USDT']; 
                break;
            case "usdttobtc": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [USDT_ADDRESS, BTC_ADDRESS, 'USDT', 'BTC']; 
                break;
            case "btctousdt": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [BTC_ADDRESS, USDT_ADDRESS, 'BTC', 'USDT']; 
                break;
            case "btctoeth": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [BTC_ADDRESS, ETH_ADDRESS, 'BTC', 'ETH']; 
                break;
            case "ethtobtc": 
                [tokenInAddress, tokenOutAddress, tokenInName, tokenOutName] = [ETH_ADDRESS, BTC_ADDRESS, 'ETH', 'BTC']; 
                break;
            default: 
                throw new Error(`Arah swap tidak dikenal: ${direction}`);
        }

        logger.info(`  [${timestamp()}] Memulai Swap ${tokenInName} ➯ ${tokenOutName} (${ethers.formatUnits(amountIn, 18)} ${tokenInName})`);
        params = {
            tokenIn: tokenInAddress, tokenOut: tokenOutAddress, fee: 3000, 
            recipient: wallet.address, deadline, amountIn, 
            amountOutMinimum: 0, sqrtPriceLimitX96: 0n,
        };
        const tx = await swapContract.exactInputSingle(params, {
            gasLimit: SWAP_GAS_LIMIT, ...selectedGasOptions, nonce: nonceForSwap 
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

async function runSwapCycle(
    pairName,
    tokenA_Address, tokenA_Name, amountToSwap_A_Fixed,
    tokenB_Address, tokenB_Name,
    totalCycles
) {
    logger.step(`Memulai Sequence Swap Bolak-Balik ${pairName} (${totalCycles} siklus)`);
    let overallSuccessCycles = 0;
    let overallFailureCycles = 0;

    for (let cycle = 1; cycle <= totalCycles; cycle++) {
        logger.info(`[${timestamp()}] [${pairName}] Siklus ke-${cycle}/${totalCycles}`);
        
        const tokenAContractProvider = new ethers.Contract(tokenA_Address, ERC20_ABI, provider);
        let currentBalanceA = await tokenAContractProvider.balanceOf(wallet.address);

        if (currentBalanceA < amountToSwap_A_Fixed) {
            logger.warn(`  [${timestamp()}] Saldo ${tokenA_Name} (${ethers.formatUnits(currentBalanceA, 18)}) tidak cukup untuk swap A->B. Melewati siklus ${cycle}.`);
            overallFailureCycles++;
            if (cycle < totalCycles) {
                const delaySeconds = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
                logger.progress(`  [${timestamp()}] Menunggu ${delaySeconds} detik sebelum siklus berikutnya...`);
                await delay(delaySeconds * 1000);
            }
            continue; 
        }
        
        logger.info(`  Langkah 1: ${tokenA_Name} ➯ ${tokenB_Name}`);
        const tokenAContractForApproval = new ethers.Contract(tokenA_Address, ERC20_ABI, wallet);
        const allowanceA = await tokenAContractForApproval.allowance(wallet.address, ROUTER_ADDRESS);
        let approveASuccess = true;
        if (allowanceA < amountToSwap_A_Fixed) {
            logger.info(`  [${timestamp()}] Approval diperlukan untuk ${tokenA_Name}.`);
            approveASuccess = await addTransactionToQueue(
                (nonce) => approveToken(tokenA_Address, amountToSwap_A_Fixed, nonce),
                `${pairName} Siklus ${cycle} - Approve ${tokenA_Name}`
            );
            if (approveASuccess) await delay(3000);
        } else {
            logger.info(`  [${timestamp()}] Approval sudah ada untuk ${tokenA_Name}.`);
        }

        let swapAtoB_Success = false;
        if (approveASuccess) {
            swapAtoB_Success = await addTransactionToQueue(
                (nonce) => swapAuto(`${tokenA_Name.toLowerCase()}To${tokenB_Name.toLowerCase()}`, amountToSwap_A_Fixed, nonce),
                `${pairName} Siklus ${cycle} - Swap ${tokenA_Name} ➯ ${tokenB_Name}`
            );
        }

        if (!swapAtoB_Success) {
            logger.error(`    Swap ${tokenA_Name} ➯ ${tokenB_Name} pada siklus ${cycle} gagal.`);
            overallFailureCycles++;
            if (cycle < totalCycles) {
                const delaySeconds = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
                logger.progress(`  [${timestamp()}] Menunggu ${delaySeconds} detik sebelum siklus berikutnya...`);
                await delay(delaySeconds * 1000);
            }
            continue; 
        }

        await delay(10000); 
        
        const tokenBContractProvider = new ethers.Contract(tokenB_Address, ERC20_ABI, provider);
        const currentBalanceOfTokenB = await tokenBContractProvider.balanceOf(wallet.address);

        let minBalanceToKeepForTokenB = 0n;
        if (tokenB_Address.toLowerCase() === ETH_ADDRESS.toLowerCase()) minBalanceToKeepForTokenB = MIN_ETH_BALANCE;
        else if (tokenB_Address.toLowerCase() === BTC_ADDRESS.toLowerCase()) minBalanceToKeepForTokenB = MIN_BTC_BALANCE;
        else if (tokenB_Address.toLowerCase() === USDT_ADDRESS.toLowerCase()) minBalanceToKeepForTokenB = MIN_USDT_BALANCE; 

        let amountToSwap_B_Dynamic = 0n;
        if (currentBalanceOfTokenB > minBalanceToKeepForTokenB) {
            amountToSwap_B_Dynamic = currentBalanceOfTokenB - minBalanceToKeepForTokenB;
        }

        if (amountToSwap_B_Dynamic > 0n) {
            logger.info(`  Langkah 2: ${tokenB_Name} ➯ ${tokenA_Name} (Swap ${ethers.formatUnits(amountToSwap_B_Dynamic, 18)} ${tokenB_Name}, sisakan ~${ethers.formatUnits(minBalanceToKeepForTokenB, 18)} ${tokenB_Name})`);
            const tokenBContractForApproval = new ethers.Contract(tokenB_Address, ERC20_ABI, wallet);
            const allowanceB = await tokenBContractForApproval.allowance(wallet.address, ROUTER_ADDRESS);
            let approveBSuccess = true;
            if (allowanceB < amountToSwap_B_Dynamic) {
                logger.info(`  [${timestamp()}] Approval diperlukan untuk ${tokenB_Name} (sejumlah ${ethers.formatUnits(amountToSwap_B_Dynamic,18)}).`);
                 approveBSuccess = await addTransactionToQueue(
                    (nonce) => approveToken(tokenB_Address, amountToSwap_B_Dynamic, nonce),
                    `${pairName} Siklus ${cycle} - Approve ${tokenB_Name} (untuk B->A)`
                );
                if (approveBSuccess) await delay(3000);
            } else {
                logger.info(`  [${timestamp()}] Approval sudah ada untuk ${tokenB_Name} (sejumlah ${ethers.formatUnits(amountToSwap_B_Dynamic,18)}).`);
            }

            let swapBtoA_Success = false;
            if (approveBSuccess) {
                swapBtoA_Success = await addTransactionToQueue(
                    (nonce) => swapAuto(`${tokenB_Name.toLowerCase()}To${tokenA_Name.toLowerCase()}`, amountToSwap_B_Dynamic, nonce),
                    `${pairName} Siklus ${cycle} - Swap ${tokenB_Name} ➯ ${tokenA_Name}`
                );
            }

            if (swapBtoA_Success) {
                logger.success(`    Siklus ${cycle} ${pairName} bolak-balik berhasil!`);
                overallSuccessCycles++;
            } else {
                logger.error(`    Swap ${tokenB_Name} ➯ ${tokenA_Name} pada siklus ${cycle} gagal.`);
                overallFailureCycles++;
            }
        } else {
            logger.warn(`  [${timestamp()}] Saldo ${tokenB_Name} (${ethers.formatUnits(currentBalanceOfTokenB,18)}) tidak cukup untuk diswap kembali setelah menyisakan minimum, atau sudah 0. Swap B->A dilewati untuk siklus ${cycle}.`);
        }

        if (cycle < totalCycles) {
            const delaySeconds = Math.floor(Math.random() * (10 - 5 + 1)) + 5;
            logger.progress(`  [${timestamp()}] Menunggu ${delaySeconds} detik sebelum siklus berikutnya...`);
            await delay(delaySeconds * 1000);
        }
    }
    logger.info(`[${timestamp()}] Sequence Swap Bolak-Balik ${pairName} Selesai. Siklus Sukses: ${overallSuccessCycles}, Siklus Gagal/Tidak Lengkap: ${overallFailureCycles}`);
    return { success: overallSuccessCycles, failure: overallFailureCycles };
}

async function main() {
    console.log("=============================================");
    console.log("     0G LABS AUTO SWAP BOT (Konsol)     ");
    console.log("=============================================");
    
    let overallSummary = `🔔 *Ringkasan Eksekusi Bot 0G (${NETWORK_NAME})* 🔔\nWallet: ${wallet.address}\nTimestamp: ${timestamp()}\n\n`;
    let totalCyclesSuccess = 0;
    let totalCyclesFailed = 0;

    try {
        const CYCLES_PER_PAIR = parseInt(process.env.CYCLES_PER_PAIR) || 3; 
        const USDT_SWAP_AMOUNT_FIXED = ethers.parseUnits(process.env.USDT_SWAP_AMOUNT || "50", 18); 
        const ETH_SWAP_AMOUNT_FIXED = ethers.parseUnits(process.env.ETH_SWAP_AMOUNT || "0.01", 18);  
        const BTC_SWAP_AMOUNT_FIXED = ethers.parseUnits(process.env.BTC_SWAP_AMOUNT || "0.001", 18); 

        logger.info(`[${timestamp()}] Memulai Bot... Network: ${NETWORK_NAME}`);
        let balances = await updateWalletData(); // Log penuh di awal
        if (!balances) {
            const errMessage = "Gagal memuat saldo awal karena masalah RPC. Bot tidak bisa melanjutkan.";
            logger.error(`[${timestamp()}] ${errMessage}`);
            await sendTelegramNotification(`🚨 BOT ERROR 🚨\n${errMessage}`);
            process.exit(1);
        }

        if (balances.balanceNative < MIN_AOGI_BALANCE_FOR_GAS) {
            const errMessage = `[${timestamp()}] Saldo AOGI (${ethers.formatEther(balances.balanceNative)}) tidak cukup untuk gas (Min: ${ethers.formatEther(MIN_AOGI_BALANCE_FOR_GAS)}). Bot berhenti.`;
            logger.error(errMessage);
            await sendTelegramNotification(`🚨 BOT STOPPED 🚨\n${errMessage}`);
            process.exit(1);
        }

        logger.progress(`[${timestamp()}] Mengambil Gas Fee Data...`);
        const feeData = await provider.getFeeData();
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            selectedGasOptions = { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas };
            logger.info(`[${timestamp()}] Gas (EIP-1559): MaxFee=${ethers.formatUnits(selectedGasOptions.maxFeePerGas, "gwei")} | PrioFee=${ethers.formatUnits(selectedGasOptions.maxPriorityFeePerGas, "gwei")} Gwei`);
        } else if (feeData.gasPrice) {
            selectedGasOptions = { gasPrice: feeData.gasPrice * 120n / 100n };
            logger.info(`[${timestamp()}] Gas (Legacy): ${ethers.formatUnits(selectedGasOptions.gasPrice, "gwei")} Gwei`);
        } else {
            selectedGasOptions = { gasPrice: ethers.parseUnits("2", "gwei") };
            logger.warn(`[${timestamp()}] Gagal ambil fee, Gas (Default): ${ethers.formatUnits(selectedGasOptions.gasPrice, "gwei")} Gwei`);
        }
        if (!selectedGasOptions.maxFeePerGas && !selectedGasOptions.gasPrice) throw new Error("Gagal menetapkan opsi gas.");

        logger.step("Memulai Fase Pemeriksaan & Pengisian Saldo Kritis (jika perlu)");
        
        // Panggil updateWalletData sekali di awal fase pengisian
        balances = await updateWalletData(false); 
        if (!balances) {
            logger.error("[${timestamp()}] Gagal mendapatkan data saldo untuk fase pengisian. Melewati fase ini.");
            await sendTelegramNotification("🚨 Peringatan Bot 0G: Gagal memuat data saldo untuk fase pengisian awal.");
        } else {
            // Replenish USDT
            if (balances.balanceUSDT <= MIN_USDT_BALANCE) {
                logger.warn(`[${timestamp()}] Saldo USDT (${ethers.formatUnits(balances.balanceUSDT,18)}) rendah atau pas minimum. Mencoba mengisi...`);
                if (balances.balanceETH > (MIN_ETH_BALANCE + ETH_SWAP_AMOUNT_FIXED)) {
                    logger.info("  Mencoba swap ETH ke USDT untuk pengisian...");
                    let approved = await addTransactionToQueue( (nonce) => approveToken(ETH_ADDRESS, ETH_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve ETH (untuk USDT)" );
                    if(approved) { 
                        if(nextNonce !== null) await delay(3000);
                        await addTransactionToQueue( (nonce) => swapAuto("ethToUsdt", ETH_SWAP_AMOUNT_FIXED, nonce), "Pengisian - ETH ke USDT" );
                    }
                } else if (balances.balanceBTC > (MIN_BTC_BALANCE + BTC_SWAP_AMOUNT_FIXED)) { 
                    logger.info("  Mencoba swap BTC ke USDT untuk pengisian...");
                    let approved = await addTransactionToQueue( (nonce) => approveToken(BTC_ADDRESS, BTC_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve BTC (untuk USDT)" );
                    if(approved) {
                        if(nextNonce !== null) await delay(3000);
                        await addTransactionToQueue( (nonce) => swapAuto("btcToUsdt", BTC_SWAP_AMOUNT_FIXED, nonce), "Pengisian - BTC ke USDT" );
                    }
                } else { 
                    logger.warn("  Tidak cukup surplus ETH atau BTC untuk mengisi USDT."); 
                }
            }
            await transactionQueue; 
            balances = await updateWalletData(false); // Update lagi setelah potensi pengisian USDT
            if (!balances) { /* ... handle error seperti di atas ...*/ }
            else { // Lanjutkan jika balances valid
                // Replenish ETH
                if (balances.balanceETH <= MIN_ETH_BALANCE) {
                    logger.warn(`[${timestamp()}] Saldo ETH (${ethers.formatUnits(balances.balanceETH,18)}) rendah atau pas minimum. Mencoba mengisi...`);
                    if (balances.balanceUSDT > (MIN_USDT_BALANCE + USDT_SWAP_AMOUNT_FIXED)) {
                         let approved = await addTransactionToQueue( (nonce) => approveToken(USDT_ADDRESS, USDT_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve USDT (untuk ETH)" );
                         if(approved) {
                            if(nextNonce !== null) await delay(3000);
                            await addTransactionToQueue( (nonce) => swapAuto("usdtToEth", USDT_SWAP_AMOUNT_FIXED, nonce), "Pengisian - USDT ke ETH" );
                         }
                    } else if (balances.balanceBTC > (MIN_BTC_BALANCE + BTC_SWAP_AMOUNT_FIXED)) { 
                        logger.info("  Mencoba swap BTC ke ETH untuk pengisian...");
                        let approved = await addTransactionToQueue( (nonce) => approveToken(BTC_ADDRESS, BTC_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve BTC (untuk ETH)" );
                        if(approved) {
                            if(nextNonce !== null) await delay(3000);
                            await addTransactionToQueue( (nonce) => swapAuto("btcToEth", BTC_SWAP_AMOUNT_FIXED, nonce), "Pengisian - BTC ke ETH" );
                        }
                    } else {
                        logger.warn("  Tidak cukup surplus USDT atau BTC untuk mengisi ETH.");
                    }
                }
                await transactionQueue;
                balances = await updateWalletData(false); // Update lagi
                if (!balances) { /* ... handle error ...*/ }
                else { // Lanjutkan jika balances valid
                    // Replenish BTC
                    if (balances.balanceBTC <= MIN_BTC_BALANCE) {
                        logger.warn(`[${timestamp()}] Saldo BTC (${ethers.formatUnits(balances.balanceBTC,18)}) rendah atau pas minimum. Mencoba mengisi...`);
                        if (balances.balanceUSDT > (MIN_USDT_BALANCE + USDT_SWAP_AMOUNT_FIXED)) {
                             let approved = await addTransactionToQueue( (nonce) => approveToken(USDT_ADDRESS, USDT_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve USDT (untuk BTC)" );
                             if(approved) {
                                if(nextNonce !== null) await delay(3000);
                                await addTransactionToQueue( (nonce) => swapAuto("usdtToBtc", USDT_SWAP_AMOUNT_FIXED, nonce), "Pengisian - USDT ke BTC" );
                             }
                        } else if (balances.balanceETH > (MIN_ETH_BALANCE + ETH_SWAP_AMOUNT_FIXED)) {
                            logger.info("  Mencoba swap ETH ke BTC untuk pengisian...");
                            let approved = await addTransactionToQueue( (nonce) => approveToken(ETH_ADDRESS, ETH_SWAP_AMOUNT_FIXED, nonce), "Pengisian - Approve ETH (untuk BTC)" );
                            if(approved) {
                                if(nextNonce !== null) await delay(3000);
                                await addTransactionToQueue( (nonce) => swapAuto("ethToBtc", ETH_SWAP_AMOUNT_FIXED, nonce), "Pengisian - ETH ke BTC" );
                            }
                        } else {
                             logger.warn("  Tidak cukup surplus USDT atau ETH untuk mengisi BTC.");
                        }
                    }
                }
            }
        }
        
        logger.info(`[${timestamp()}] Menunggu transaksi pengisian saldo (jika ada) selesai...`);
        await transactionQueue; 
        const balancesAfterReplenish = await updateWalletData(true); 
        if (balancesAfterReplenish && balancesAfterReplenish.reportString) {
            overallSummary += "Saldo Setelah Pengisian Awal:\n" + balancesAfterReplenish.reportString + "\n\n";
        } else {
            overallSummary += "Saldo Setelah Pengisian Awal: Gagal mengambil data saldo.\n\n";
        }

        logger.step("Memulai Fase Swap Rutin Bolak-Balik");
        let result;

        result = await runSwapCycle("USDT & ETH", USDT_ADDRESS, "USDT", USDT_SWAP_AMOUNT_FIXED, ETH_ADDRESS, "ETH", CYCLES_PER_PAIR);
        if(result) { totalCyclesSuccess += result.success; totalCyclesFailed += result.failure; }
        overallSummary += `USDT<>ETH: ${result?.success || 0} siklus sukses, ${result?.failure || 0} gagal/tdk lengkap.\n`;
        await updateWalletData(); await delay(15000); 

        result = await runSwapCycle("USDT & BTC", USDT_ADDRESS, "USDT", USDT_SWAP_AMOUNT_FIXED, BTC_ADDRESS, "BTC", CYCLES_PER_PAIR);
        if(result) { totalCyclesSuccess += result.success; totalCyclesFailed += result.failure; }
        overallSummary += `USDT<>BTC: ${result?.success || 0} siklus sukses, ${result?.failure || 0} gagal/tdk lengkap.\n`;
        await updateWalletData(); await delay(15000); 

        result = await runSwapCycle("BTC & ETH", BTC_ADDRESS, "BTC", BTC_SWAP_AMOUNT_FIXED, ETH_ADDRESS, "ETH", CYCLES_PER_PAIR);
        if(result) { totalCyclesSuccess += result.success; totalCyclesFailed += result.failure; }
        overallSummary += `BTC<>ETH: ${result?.success || 0} siklus sukses, ${result?.failure || 0} gagal/tdk lengkap.\n`;
        const balancesAfterRoutine = await updateWalletData(); // Update saldo terakhir sebelum final summary

        logger.info(`[${timestamp()}] Semua sequence swap telah selesai ditambahkan ke antrean.`);
        logger.progress(`[${timestamp()}] Menunggu semua transaksi di antrean selesai...`);
        
        await transactionQueue; 
        let finalNonceCheck = await provider.getTransactionCount(wallet.address, "pending");
        while (nextNonce !== null && finalNonceCheck < nextNonce ) {
             logger.progress(`[${timestamp()}] Menunggu konfirmasi transaksi terakhir... (Nonce jaringan: ${finalNonceCheck}, Target nonce script: ${nextNonce})`);
             await delay(15000); 
             finalNonceCheck = await provider.getTransactionCount(wallet.address, "pending");
        }
        
        const finalBalances = await updateWalletData(true); // Log saldo akhir secara penuh
        if (finalBalances && finalBalances.reportString) {
            overallSummary += "\nSaldo Akhir Aktual:\n" + finalBalances.reportString + "\n\n";
        } else {
            overallSummary += "\nSaldo Akhir Aktual: Gagal mengambil data saldo.\n\n";
        }
        overallSummary += `Total Siklus Sukses (gabungan): ${totalCyclesSuccess}\nTotal Siklus Gagal/Tdk Lengkap (gabungan): ${totalCyclesFailed}\n`;
        overallSummary += "✨ SEMUA OPERASI SELESAI! ✨";

        const consoleSummary = overallSummary.replace(/\[✓\]\s/g, '').replace(/\[⏳\]\s/g, '').replace(/\[⚠\]\s/g, '').replace(/\[✗\]\s/g, '').replace(/---/g, '').replace(/🔔/g, '').replace(/\*/g, '');
        logger.info(consoleSummary); 
        await sendTelegramNotification(overallSummary);
        process.exit(0);

    } catch (error) {
        const errorMessage = `[${timestamp()}] Terjadi error fatal di main: ${error.message}`;
        logger.error(errorMessage);
        console.error(error); // Tetap log error detail ke konsol
        await sendTelegramNotification(`🚨 *ERROR FATAL BOT 0G* 🚨\n\n${errorMessage}\n\nCek log konsol untuk detail.`);
        process.exit(1);
    }
}

main();

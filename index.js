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
// const AOGI_ADDRESS = process.env.AOGI_ADDRESS; // AOGI sepertinya hanya untuk fee, tidak diswap?
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
const ERC20_ABI = [ // <-- Hanya satu ABI untuk semua ERC20
    { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_spender", type: "address" }, { name: "_value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "_owner", type: "address" }, { name: "_spender", type: "address" }], outputs: [{ name: "remaining", type: "uint256" }] }
];

const ROUTER_ABI = [ // <-- Tetap sama
    { inputs: [{ components: [ { internalType: "address", name: "tokenIn", type: "address" }, { internalType: "address", name: "tokenOut", type: "address" }, { internalType: "uint24", name: "fee", type: "uint24" }, { internalType: "address", name: "recipient", type: "address" }, { internalType: "uint256", name: "deadline", type: "uint256" }, { internalType: "uint256", name: "amountIn", type: "uint256" }, { internalType: "uint256", name: "amountOutMinimum", type: "uint256" }, { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" }, ], internalType: "struct ISwapRouter.ExactInputSingleParams", name: "params", type: "tuple", }, ], name: "exactInputSingle", outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }], stateMutability: "payable", type: "function", },
];

// =========================================================================
// STATE & UTILITIES
// =========================================================================
let transactionQueue = Promise.resolve();
let nextNonce = null;
let selectedGasPrice = null;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const shortHash = (hash) => `${hash.substring(0, 6)}...${hash.substring(hash.length - 4)}`;
const timestamp = () => new Date().toLocaleTimeString();

// =========================================================================
// FUNGSI INTI (Dimodifikasi untuk Konsol)
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
        logger.info(`  USDT : ${parseFloat(ethers.formatUnits(balanceUSDT, 18)).toFixed(4)}`); // Pastikan desimal USDT benar (biasanya 6 atau 18)
        logger.info(`  BTC  : ${parseFloat(ethers.formatUnits(balanceBTC, 18)).toFixed(4)}`); // Pastikan desimal BTC benar (biasanya 8 atau 18)
    } catch (error) {
        logger.error(`[${timestamp()}] Gagal mengambil data wallet: ${error.message}`);
    }
}

async function approveToken(tokenAddress, amount) {
    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet); // Gunakan ERC20_ABI
        const currentAllowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
        if (currentAllowance >= amount) {
            logger.info(`  [${timestamp()}] Approval tidak diperlukan.`);
            return true;
        }
        const tx = await tokenContract.approve(ROUTER_ADDRESS, amount, {
            gasLimit: APPROVAL_GAS_LIMIT,
            gasPrice: selectedGasPrice
        });
        logger.progress(`  [${timestamp()}] Approval Tx Dikirim: ${shortHash(tx.hash)}`);
        await tx.wait();
        logger.info(`  [${timestamp()}] Approval berhasil.`);
        return true;
    } catch (error) {
        logger.error(`  [${timestamp()}] Approval gagal: ${error.message}`);
        return false;
    }
}

async function swapAuto(direction, amountIn) {
    try {
        const swapContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
        const deadline = Math.floor(Date.now() / 1000) + 120; // 2 menit deadline
        let params;
        let tokenInAddress, tokenOutAddress, tokenInName, tokenOutName;

        // Tentukan token berdasarkan arah swap
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

        // Approve dulu (jika belum)
        const approved = await approveToken(tokenInAddress, amountIn);
        if (!approved) throw new Error("Approval gagal, swap dibatalkan.");
        await delay(2000); // Jeda singkat setelah approve

        params = {
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            fee: 3000, // Fee 0.3% (umum, sesuaikan jika perlu)
            recipient: wallet.address,
            deadline,
            amountIn,
            amountOutMinimum: 0, // Set 0 untuk kesederhanaan, BAHAYA di production!
            sqrtPriceLimitX96: 0n,
        };

        const tx = await swapContract.exactInputSingle(params, {
            gasLimit: SWAP_GAS_LIMIT,
            gasPrice: selectedGasPrice,
            nonce: nextNonce // <-- Gunakan nonce dari antrean
        });
        logger.progress(`  [${timestamp()}] Swap Tx Dikirim: ${shortHash(tx.hash)}`);
        const receipt = await tx.wait();
        const feeAOGI = ethers.formatEther(receipt.gasUsed * selectedGasPrice);
        logger.info(`  [${timestamp()}] Swap Tx Berhasil: ${shortHash(tx.hash)} | Fee: ${feeAOGI} AOGI`);
        return true;

    } catch (error) {
        logger.error(`  [${timestamp()}] Swap ${direction} gagal: ${error.message}`);
        if (error.message && error.message.toLowerCase().includes("nonce")) {
            logger.warn(`  [${timestamp()}] Terdeteksi error nonce, mencoba refresh nonce...`);
            nextNonce = null; // Set null agar diambil lagi di antrean berikutnya
        }
        return false; // Kembalikan false jika gagal
    }
}

function addTransactionToQueue(transactionFunction, description) {
    transactionQueue = transactionQueue.then(async () => {
        logger.progress(`[${timestamp()}] Memproses: ${description}`);
        try {
            // Ambil nonce terbaru HANYA jika belum ada atau diset null (karena error nonce)
            if (nextNonce === null) {
                nextNonce = await provider.getTransactionCount(wallet.address, "pending");
                logger.info(`[${timestamp()}] Nonce saat ini: ${nextNonce}`);
            }

            const success = await transactionFunction(nextNonce);

            // Hanya increment nonce jika transaksi berhasil DIKIRIM (tidak harus confirmed, tapi setidaknya tidak error *sebelum* kirim)
            // Namun, karena kita `await tx.wait()`, kita increment jika sukses confirmed.
            if (success) {
                nextNonce++;
            } else {
                // Jika gagal, coba refresh nonce di pemanggilan berikutnya
                nextNonce = null;
            }
            return success;
        } catch (error) {
            logger.error(`[${timestamp()}] Error dalam antrean [${description}]: ${error.message}`);
            nextNonce = null; // Refresh nonce jika ada error tak terduga
            return false;
        }
    }).catch(err => {
        logger.error(`[${timestamp()}] Error fatal di rantai Promise: ${err.message}`);
        nextNonce = null;
        return false; // Lanjutkan rantai
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
        const tokenName = direction.split("To")[0].toUpperCase();

        logger.info(`[${timestamp()}] [${pairName}] Swap ke-${i}/${totalSwaps} | Arah: ${direction}`);

        // Cek Saldo (sederhana, bisa ditingkatkan)
        const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
        const currentBalance = await tokenContract.balanceOf(wallet.address);
        if (currentBalance < amount) {
            logger.warn(`  [${timestamp()}] Saldo ${tokenName} (${ethers.formatUnits(currentBalance, 18)}) tidak cukup. Melewati swap.`);
            failureCount++;
        } else {
            const success = await addTransactionToQueue(
                (nonce) => swapAuto(direction, amount),
                `${pairName} - Swap ${i}`
            );
            if (success) successCount++;
            else failureCount++;
        }

        // Jeda sebelum swap berikutnya (jika bukan yang terakhir)
        if (i < totalSwaps) {
            const delaySeconds = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
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
        const SWAPS_PER_PAIR = 5; // <-- Atur berapa kali swap per pasangan
        const USDT_SWAP_AMOUNT = ethers.parseUnits("100", 18); // 100 USDT (sesuaikan desimal jika perlu)
        const ETH_SWAP_AMOUNT = ethers.parseUnits("0.03", 18); // 0.03 ETH
        const BTC_SWAP_AMOUNT = ethers.parseUnits("0.003", 18); // 0.003 BTC (sesuaikan desimal jika perlu)

        logger.info(`[${timestamp()}] Memulai Bot... Network: ${NETWORK_NAME}`);
        await updateWalletData();

        // Ambil gas price normal sekali saja
        // Ambil gas price TAPI KITA PAKSA NILAI LEBIH TINGGI UNTUK TES
        logger.progress(`[${timestamp()}] Menetapkan Gas Price (Manual)...`);
        
        // !! KITA PAKSA GUNAKAN 5 GWEI UNTUK TES !!
        selectedGasPrice = ethers.parseUnits("5", "gwei"); 

        if (!selectedGasPrice) throw new Error("Gagal menetapkan gas price.");
        logger.info(`[${timestamp()}] Gas Price ditetapkan (Manual): ${ethers.formatUnits(selectedGasPrice, "gwei")} Gwei`);
        // Jalankan sequence USDT & ETH
        await runSwapSequence("USDT & ETH", "usdtToEth", "ethToUsdt", SWAPS_PER_PAIR, USDT_SWAP_AMOUNT, ETH_SWAP_AMOUNT, USDT_ADDRESS, ETH_ADDRESS);
        await updateWalletData(); // Update saldo setelah sequence 1
        await delay(60000); // Jeda 1 menit antar sequence

        // Jalankan sequence USDT & BTC
        await runSwapSequence("USDT & BTC", "usdtToBtc", "btcToUsdt", SWAPS_PER_PAIR, USDT_SWAP_AMOUNT, BTC_SWAP_AMOUNT, USDT_ADDRESS, BTC_ADDRESS);
        await updateWalletData(); // Update saldo setelah sequence 2
        await delay(60000); // Jeda 1 menit antar sequence

        // Jalankan sequence BTC & ETH
        await runSwapSequence("BTC & ETH", "btcToEth", "ethToBtc", SWAPS_PER_PAIR, BTC_SWAP_AMOUNT, ETH_SWAP_AMOUNT, BTC_ADDRESS, ETH_ADDRESS);
        await updateWalletData(); // Update saldo setelah sequence 3

        logger.info(`[${timestamp()}] Semua sequence swap telah selesai ditambahkan ke antrean.`);
        logger.progress(`[${timestamp()}] Menunggu semua transaksi di antrean selesai...`);

        // Tunggu hingga antrean kosong (dengan cara sederhana)
        await transactionQueue; // Tunggu promise terakhir
        while (nextNonce !== null && (await provider.getTransactionCount(wallet.address, "pending")) > nextNonce -1 ) {
             logger.progress(`[${timestamp()}] Masih ada transaksi yang diproses, menunggu...`);
             await delay(15000); // Cek setiap 15 detik
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

// Jalankan
main();

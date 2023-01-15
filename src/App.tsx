import "./App.css";
import { useMemo } from "react";
import * as anchor from "@project-serum/anchor";
import { DEFAULT_TIMEOUT } from "./connection";
import { clusterApiUrl } from "@solana/web3.js";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletDialogProvider } from "@solana/wallet-adapter-material-ui";

import { createTheme, ThemeProvider } from "@mui/material";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SlopeWalletAdapter } from "@solana/wallet-adapter-slope";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import {
  SolletWalletAdapter,
  SolletExtensionWalletAdapter,
} from "@solana/wallet-adapter-sollet";
import MultipleHome from "./MultipleHome";

const theme = createTheme({
  palette: {
    mode: "dark",
  },
});

const getCandyMachineIdStandard = (): anchor.web3.PublicKey | undefined => {
  try {
    return new anchor.web3.PublicKey(
      process.env.REACT_APP_CANDY_MACHINE_ID_STANDARD!
    );
  } catch (e) {
    console.log("Failed to construct CandyMachineId", e);
    return undefined;
  }
};

const getCandyMachineIdPremium = (): anchor.web3.PublicKey | undefined => {
  try {
    return new anchor.web3.PublicKey(
      process.env.REACT_APP_CANDY_MACHINE_ID_PREMIUM!
    );
  } catch (e) {
    console.log("Failed to construct CandyMachineId", e);
    return undefined;
  }
};

let error: string | undefined = undefined;

if (process.env.REACT_APP_SOLANA_NETWORK === undefined) {
  error =
    "Your REACT_APP_SOLANA_NETWORK value in the .env file doesn't look right! The options are devnet and mainnet-beta!";
} else if (process.env.REACT_APP_SOLANA_RPC_HOST === undefined) {
  error =
    "Your REACT_APP_SOLANA_RPC_HOST value in the .env file doesn't look right! Make sure you enter it in as a plain-text url (i.e., https://metaplex.devnet.rpcpool.com/)";
}

const candyMachineIdStandard = getCandyMachineIdStandard();
const candyMachineIdPremium = getCandyMachineIdPremium();
const network = (process.env.REACT_APP_SOLANA_NETWORK ??
  "devnet") as WalletAdapterNetwork;
const rpcHost =
  process.env.REACT_APP_SOLANA_RPC_HOST ?? anchor.web3.clusterApiUrl("devnet");
const connection = new anchor.web3.Connection(rpcHost);

const App = () => {
  const endpoint = useMemo(() => clusterApiUrl(network), []);

  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network }),
      new SlopeWalletAdapter(),
      new SolletWalletAdapter({ network }),
      new SolletExtensionWalletAdapter({ network }),
    ],
    []
  );

  return (
    <ThemeProvider theme={theme}>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletDialogProvider>
            <MultipleHome
              candyMachineIdStandard={candyMachineIdStandard}
              candyMachineIdPremium={candyMachineIdPremium}
              connection={connection}
              txTimeout={DEFAULT_TIMEOUT}
              rpcHost={rpcHost}
              network={network}
              error={error}
            ></MultipleHome>
            {/* <Home
              candyMachineId={candyMachineIdStandard}
              connection={connection}
              txTimeout={DEFAULT_TIMEOUT}
              rpcHost={rpcHost}
              network={network}
              error={error}
            />
            <Home
              candyMachineId={candyMachineIdPremium}
              connection={connection}
              txTimeout={DEFAULT_TIMEOUT}
              rpcHost={rpcHost}
              network={network}
              error={error}
            /> */}
          </WalletDialogProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ThemeProvider>
  );
};

export default App;

import { useCallback, useEffect, useState } from "react";
import * as anchor from "@project-serum/anchor";

import styled from "styled-components";
import { Box, Container, Snackbar } from "@mui/material";
import Paper from "@mui/material/Paper";
import Alert from "@mui/lab/Alert";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import {
  Commitment,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { WalletDialogButton } from "@solana/wallet-adapter-material-ui";
import {
  awaitTransactionSignatureConfirmation,
  CANDY_MACHINE_PROGRAM,
  CandyMachineAccount,
  createAccountsForMint,
  getCandyMachineState,
  getCollectionPDA,
  mintOneToken,
  SetupState,
} from "./candy-machine";
import { AlertState, formatNumber, getAtaForMint, toDate } from "./utils";
import { MintCountdown } from "./MintCountdown";
import { MintButton } from "./MintButton";
import { GatewayProvider } from "@civic/solana-gateway-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { SolanaMobileWalletAdapterWalletName } from "@solana-mobile/wallet-adapter-mobile";
import { CrossmintPayButton } from "@crossmint/client-sdk-react-ui";

const ConnectButton = styled(WalletDialogButton)`
  width: 100%;
  height: 60px;
  margin-top: 10px;
  margin-bottom: 5px;
  background: linear-gradient(180deg, #604ae5 0%, #813eee 100%);
  color: white;
  font-size: 16px;
  font-weight: bold;
`;

const MintContainer = styled.div``; // add your owns styles here
const crossMintPremiumKey: string = (process.env.REACT_APP_CROSSMINT_ID_PREMIUM as string);
const crossMintStandardKey: string = (process.env.REACT_APP_CROSSMINT_ID_STANDARD as string);

export interface HomeProps {
  candyMachineIdStandard?: anchor.web3.PublicKey;
  candyMachineIdPremium?: anchor.web3.PublicKey;
  connection: anchor.web3.Connection;
  txTimeout: number;
  rpcHost: string;
  network: WalletAdapterNetwork;
  error?: string;
}

const MultipleHome = (props: HomeProps) => {
  const [isUserMinting, setIsUserMinting] = useState(false);
  const [standardCandyMachine, setStandardCandyMachine] =
    useState<CandyMachineAccount>();
  const [premiumCandyMachine, setPremiumCandyMachine] =
    useState<CandyMachineAccount>();
  const [alertState, setAlertState] = useState<AlertState>({
    open: false,
    message: "",
    severity: undefined,
  });
  const [isActive, setIsActive] = useState(false);
  const [endDate, setEndDate] = useState<Date>();
  const [itemsRemainingStandard, setItemsRemainingStandard] =
    useState<number>();
  const [itemsRemainingPremium, setItemsRemainingPremium] = useState<number>();
  const [isWhitelistUser, setIsWhitelistUser] = useState(false);
  const [isPresale, setIsPresale] = useState(false);
  const [isValidBalance, setIsValidBalance] = useState(false);
  const [discountPrice, setDiscountPrice] = useState<anchor.BN>();
  const [needTxnSplit, setNeedTxnSplit] = useState(true);
  const [setupTxn, setSetupTxn] = useState<SetupState>();

  const rpcUrl = props.rpcHost;
  const anchorWallet = useAnchorWallet();
  const { connect, connected, publicKey, wallet } = useWallet();
  const cluster = props.network;

  const refreshStandardCandyMachineState = useCallback(
    async (commitment: Commitment = "confirmed") => {
      if (!publicKey) {
        return;
      }
      if (props.error !== undefined) {
        setAlertState({
          open: true,
          message: props.error,
          severity: "error",
          hideDuration: null,
        });
        return;
      }

      const connection = new Connection(props.rpcHost, commitment);

      if (props.candyMachineIdStandard) {
        try {
          const cndy = await getCandyMachineState(
            anchorWallet as anchor.Wallet,
            props.candyMachineIdStandard,
            connection
          );
          console.log("Candy machine state: ", cndy);
          let active = cndy?.state.goLiveDate
            ? cndy?.state.goLiveDate.toNumber() < new Date().getTime() / 1000
            : false;
          let presale = false;

          // duplication of state to make sure we have the right values!
          let isWLUser = false;
          let userPrice = cndy.state.price;

          // whitelist mint?
          if (cndy?.state.whitelistMintSettings) {
            // is it a presale mint?
            if (
              cndy.state.whitelistMintSettings.presale &&
              (!cndy.state.goLiveDate ||
                cndy.state.goLiveDate.toNumber() > new Date().getTime() / 1000)
            ) {
              presale = true;
            }
            // is there a discount?
            if (cndy.state.whitelistMintSettings.discountPrice) {
              setDiscountPrice(cndy.state.whitelistMintSettings.discountPrice);
              userPrice = cndy.state.whitelistMintSettings.discountPrice;
            } else {
              setDiscountPrice(undefined);
              // when presale=false and discountPrice=null, mint is restricted
              // to whitelist users only
              if (!cndy.state.whitelistMintSettings.presale) {
                cndy.state.isWhitelistOnly = true;
              }
            }
            // retrieves the whitelist token
            const mint = new anchor.web3.PublicKey(
              cndy.state.whitelistMintSettings.mint
            );
            const token = (await getAtaForMint(mint, publicKey))[0];

            try {
              const balance = await connection.getTokenAccountBalance(token);
              isWLUser = parseInt(balance.value.amount) > 0;
              // only whitelist the user if the balance > 0
              setIsWhitelistUser(isWLUser);

              if (cndy.state.isWhitelistOnly) {
                active = isWLUser && (presale || active);
              }
            } catch (e) {
              setIsWhitelistUser(false);
              // no whitelist user, no mint
              if (cndy.state.isWhitelistOnly) {
                active = false;
              }
              console.log(
                "There was a problem fetching whitelist token balance"
              );
              console.log(e);
            }
          }
          userPrice = isWLUser ? userPrice : cndy.state.price;

          if (cndy?.state.tokenMint) {
            // retrieves the SPL token
            const mint = new anchor.web3.PublicKey(cndy.state.tokenMint);
            const token = (await getAtaForMint(mint, publicKey))[0];
            try {
              const balance = await connection.getTokenAccountBalance(token);

              const valid = new anchor.BN(balance.value.amount).gte(userPrice);

              // only allow user to mint if token balance >  the user if the balance > 0
              setIsValidBalance(valid);
              active = active && valid;
            } catch (e) {
              setIsValidBalance(false);
              active = false;
              // no whitelist user, no mint
              console.log("There was a problem fetching SPL token balance");
              console.log(e);
            }
          } else {
            const balance = new anchor.BN(
              await connection.getBalance(publicKey)
            );
            const valid = balance.gte(userPrice);
            setIsValidBalance(valid);
            active = active && valid;
          }

          // datetime to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.date) {
            setEndDate(toDate(cndy.state.endSettings.number));
            if (
              cndy.state.endSettings.number.toNumber() <
              new Date().getTime() / 1000
            ) {
              active = false;
            }
          }
          // amount to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.amount) {
            const limit = Math.min(
              cndy.state.endSettings.number.toNumber(),
              cndy.state.itemsAvailable
            );
            if (cndy.state.itemsRedeemed < limit) {
              setItemsRemainingStandard(limit - cndy.state.itemsRedeemed);
            } else {
              setItemsRemainingStandard(0);
              cndy.state.isSoldOut = true;
            }
          } else {
            setItemsRemainingStandard(cndy.state.itemsRemaining);
          }

          if (cndy.state.isSoldOut) {
            active = false;
          }

          const [collectionPDA] = await getCollectionPDA(
            props.candyMachineIdStandard
          );
          const collectionPDAAccount = await connection.getAccountInfo(
            collectionPDA
          );

          setIsActive((cndy.state.isActive = active));
          setIsPresale((cndy.state.isPresale = presale));
          setStandardCandyMachine(cndy);

          const txnEstimate =
            892 +
            (!!collectionPDAAccount && cndy.state.retainAuthority ? 182 : 0) +
            (cndy.state.tokenMint ? 66 : 0) +
            (cndy.state.whitelistMintSettings ? 34 : 0) +
            (cndy.state.whitelistMintSettings?.mode?.burnEveryTime ? 34 : 0) +
            (cndy.state.gatekeeper ? 33 : 0) +
            (cndy.state.gatekeeper?.expireOnUse ? 66 : 0);

          setNeedTxnSplit(txnEstimate > 1230);
        } catch (e) {
          if (e instanceof Error) {
            if (
              e.message ===
              `Account does not exist ${props.candyMachineIdStandard}`
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state from candy machine with address: ${props.candyMachineIdStandard}, using rpc: ${props.rpcHost}! You probably typed the REACT_APP_CANDY_MACHINE_ID value wrong in your .env file, or you are using the wrong RPC!`,
                severity: "error",
                hideDuration: null,
              });
            } else if (
              e.message.startsWith("failed to get info about account")
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state with rpc: ${props.rpcHost}! This probably means you have an issue with the REACT_APP_SOLANA_RPC_HOST value in your .env file, or you are not using a custom RPC!`,
                severity: "error",
                hideDuration: null,
              });
            }
          } else {
            setAlertState({
              open: true,
              message: `${e}`,
              severity: "error",
              hideDuration: null,
            });
          }
          console.log(e);
        }
      } else {
        setAlertState({
          open: true,
          message: `Your REACT_APP_CANDY_MACHINE_ID value in the .env file doesn't look right! Make sure you enter it in as plain base-58 address!`,
          severity: "error",
          hideDuration: null,
        });
      }
    },
    [anchorWallet, props.candyMachineIdStandard, props.error, props.rpcHost]
  );

  const refreshPremiumCandyMachineState = useCallback(
    async (commitment: Commitment = "confirmed") => {
      if (!publicKey) {
        return;
      }
      if (props.error !== undefined) {
        setAlertState({
          open: true,
          message: props.error,
          severity: "error",
          hideDuration: null,
        });
        return;
      }

      const connection = new Connection(props.rpcHost, commitment);

      if (props.candyMachineIdPremium) {
        try {
          const cndy = await getCandyMachineState(
            anchorWallet as anchor.Wallet,
            props.candyMachineIdPremium,
            connection
          );
          console.log("Candy machine state: ", cndy);
          let active = cndy?.state.goLiveDate
            ? cndy?.state.goLiveDate.toNumber() < new Date().getTime() / 1000
            : false;
          let presale = false;

          // duplication of state to make sure we have the right values!
          let isWLUser = false;
          let userPrice = cndy.state.price;

          // whitelist mint?
          if (cndy?.state.whitelistMintSettings) {
            // is it a presale mint?
            if (
              cndy.state.whitelistMintSettings.presale &&
              (!cndy.state.goLiveDate ||
                cndy.state.goLiveDate.toNumber() > new Date().getTime() / 1000)
            ) {
              presale = true;
            }
            // is there a discount?
            if (cndy.state.whitelistMintSettings.discountPrice) {
              setDiscountPrice(cndy.state.whitelistMintSettings.discountPrice);
              userPrice = cndy.state.whitelistMintSettings.discountPrice;
            } else {
              setDiscountPrice(undefined);
              // when presale=false and discountPrice=null, mint is restricted
              // to whitelist users only
              if (!cndy.state.whitelistMintSettings.presale) {
                cndy.state.isWhitelistOnly = true;
              }
            }
            // retrieves the whitelist token
            const mint = new anchor.web3.PublicKey(
              cndy.state.whitelistMintSettings.mint
            );
            const token = (await getAtaForMint(mint, publicKey))[0];

            try {
              const balance = await connection.getTokenAccountBalance(token);
              isWLUser = parseInt(balance.value.amount) > 0;
              // only whitelist the user if the balance > 0
              setIsWhitelistUser(isWLUser);

              if (cndy.state.isWhitelistOnly) {
                active = isWLUser && (presale || active);
              }
            } catch (e) {
              setIsWhitelistUser(false);
              // no whitelist user, no mint
              if (cndy.state.isWhitelistOnly) {
                active = false;
              }
              console.log(
                "There was a problem fetching whitelist token balance"
              );
              console.log(e);
            }
          }
          userPrice = isWLUser ? userPrice : cndy.state.price;

          if (cndy?.state.tokenMint) {
            // retrieves the SPL token
            const mint = new anchor.web3.PublicKey(cndy.state.tokenMint);
            const token = (await getAtaForMint(mint, publicKey))[0];
            try {
              const balance = await connection.getTokenAccountBalance(token);

              const valid = new anchor.BN(balance.value.amount).gte(userPrice);

              // only allow user to mint if token balance >  the user if the balance > 0
              setIsValidBalance(valid);
              active = active && valid;
            } catch (e) {
              setIsValidBalance(false);
              active = false;
              // no whitelist user, no mint
              console.log("There was a problem fetching SPL token balance");
              console.log(e);
            }
          } else {
            const balance = new anchor.BN(
              await connection.getBalance(publicKey)
            );
            const valid = balance.gte(userPrice);
            setIsValidBalance(valid);
            active = active && valid;
          }

          // datetime to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.date) {
            setEndDate(toDate(cndy.state.endSettings.number));
            if (
              cndy.state.endSettings.number.toNumber() <
              new Date().getTime() / 1000
            ) {
              active = false;
            }
          }
          // amount to stop the mint?
          if (cndy?.state.endSettings?.endSettingType.amount) {
            const limit = Math.min(
              cndy.state.endSettings.number.toNumber(),
              cndy.state.itemsAvailable
            );
            if (cndy.state.itemsRedeemed < limit) {
              setItemsRemainingPremium(limit - cndy.state.itemsRedeemed);
            } else {
              setItemsRemainingPremium(0);
              cndy.state.isSoldOut = true;
            }
          } else {
            setItemsRemainingPremium(cndy.state.itemsRemaining);
          }

          if (cndy.state.isSoldOut) {
            active = false;
          }

          const [collectionPDA] = await getCollectionPDA(
            props.candyMachineIdPremium
          );
          const collectionPDAAccount = await connection.getAccountInfo(
            collectionPDA
          );

          setIsActive((cndy.state.isActive = active));
          setIsPresale((cndy.state.isPresale = presale));
          setPremiumCandyMachine(cndy);

          const txnEstimate =
            892 +
            (!!collectionPDAAccount && cndy.state.retainAuthority ? 182 : 0) +
            (cndy.state.tokenMint ? 66 : 0) +
            (cndy.state.whitelistMintSettings ? 34 : 0) +
            (cndy.state.whitelistMintSettings?.mode?.burnEveryTime ? 34 : 0) +
            (cndy.state.gatekeeper ? 33 : 0) +
            (cndy.state.gatekeeper?.expireOnUse ? 66 : 0);

          setNeedTxnSplit(txnEstimate > 1230);
        } catch (e) {
          if (e instanceof Error) {
            if (
              e.message ===
              `Account does not exist ${props.candyMachineIdPremium}`
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state from candy machine with address: ${props.candyMachineIdPremium}, using rpc: ${props.rpcHost}! You probably typed the REACT_APP_CANDY_MACHINE_ID value wrong in your .env file, or you are using the wrong RPC!`,
                severity: "error",
                hideDuration: null,
              });
            } else if (
              e.message.startsWith("failed to get info about account")
            ) {
              setAlertState({
                open: true,
                message: `Couldn't fetch candy machine state with rpc: ${props.rpcHost}! This probably means you have an issue with the REACT_APP_SOLANA_RPC_HOST value in your .env file, or you are not using a custom RPC!`,
                severity: "error",
                hideDuration: null,
              });
            }
          } else {
            setAlertState({
              open: true,
              message: `${e}`,
              severity: "error",
              hideDuration: null,
            });
          }
          console.log(e);
        }
      } else {
        setAlertState({
          open: true,
          message: `Your REACT_APP_CANDY_MACHINE_ID value in the .env file doesn't look right! Make sure you enter it in as plain base-58 address!`,
          severity: "error",
          hideDuration: null,
        });
      }
    },
    [anchorWallet, props.candyMachineIdPremium, props.error, props.rpcHost]
  );

  const onStandardMint = async (
    beforeTransactions: Transaction[] = [],
    afterTransactions: Transaction[] = []
  ) => {
    try {
      setIsUserMinting(true);
      if (connected && standardCandyMachine?.program && publicKey) {
        let setupMint: SetupState | undefined;
        if (needTxnSplit && setupTxn === undefined) {
          setAlertState({
            open: true,
            message: "Please sign account setup transaction",
            severity: "info",
          });
          setupMint = await createAccountsForMint(
            standardCandyMachine,
            publicKey
          );
          let status: any = { err: true };
          if (setupMint.transaction) {
            status = await awaitTransactionSignatureConfirmation(
              setupMint.transaction,
              props.txTimeout,
              props.connection,
              true
            );
          }
          if (status && !status.err) {
            setSetupTxn(setupMint);
            setAlertState({
              open: true,
              message:
                "Setup transaction succeeded! Please sign minting transaction",
              severity: "info",
            });
          } else {
            setAlertState({
              open: true,
              message: "Mint failed! Please try again!",
              severity: "error",
            });
            setIsUserMinting(false);
            return;
          }
        } else {
          setAlertState({
            open: true,
            message: "Please sign minting transaction",
            severity: "info",
          });
        }

        const mintResult = await mintOneToken(
          standardCandyMachine,
          publicKey,
          beforeTransactions,
          afterTransactions,
          setupMint ?? setupTxn
        );

        let status: any = { err: true };
        let metadataStatus = null;
        if (mintResult) {
          status = await awaitTransactionSignatureConfirmation(
            mintResult.mintTxId,
            props.txTimeout,
            props.connection,
            true
          );

          metadataStatus =
            await standardCandyMachine.program.provider.connection.getAccountInfo(
              mintResult.metadataKey,
              "processed"
            );
          console.log("Metadata status: ", !!metadataStatus);
        }

        if (status && !status.err && metadataStatus) {
          // manual update since the refresh might not detect
          // the change immediately
          const remaining = itemsRemainingStandard! - 1;
          setItemsRemainingStandard(remaining);
          setIsActive((standardCandyMachine.state.isActive = remaining > 0));
          standardCandyMachine.state.isSoldOut = remaining === 0;
          setSetupTxn(undefined);
          setAlertState({
            open: true,
            message: "Congratulations! Mint succeeded!",
            severity: "success",
            hideDuration: 7000,
          });
          refreshStandardCandyMachineState("processed");
          refreshPremiumCandyMachineState("processed");
        } else if (status && !status.err) {
          setAlertState({
            open: true,
            message:
              "Mint likely failed! Anti-bot SOL 0.01 fee potentially charged! Check the explorer to confirm the mint failed and if so, make sure you are eligible to mint before trying again.",
            severity: "error",
            hideDuration: 8000,
          });
          refreshStandardCandyMachineState();
          refreshPremiumCandyMachineState();
        } else {
          setAlertState({
            open: true,
            message: "Mint failed! Please try again!",
            severity: "error",
          });
          refreshStandardCandyMachineState();
          refreshPremiumCandyMachineState();
        }
      }
    } catch (error: any) {
      let message = error.msg || "Minting failed! Please try again!";
      if (!error.msg) {
        if (!error.message) {
          message = "Transaction timeout! Please try again.";
        } else if (error.message.indexOf("0x137")) {
          console.log(error);
          message = `SOLD OUT!`;
        } else if (error.message.indexOf("0x135")) {
          message = `Insufficient funds to mint. Please fund your wallet.`;
        }
      } else {
        if (error.code === 311) {
          console.log(error);
          message = `SOLD OUT!`;
          window.location.reload();
        } else if (error.code === 312) {
          message = `Minting period hasn't started yet.`;
        }
      }

      setAlertState({
        open: true,
        message,
        severity: "error",
      });
      // updates the candy machine state to reflect the latest
      // information on chain
      refreshStandardCandyMachineState();
    } finally {
      setIsUserMinting(false);
    }
  };

  const onPremiumMint = async (
    beforeTransactions: Transaction[] = [],
    afterTransactions: Transaction[] = []
  ) => {
    try {
      setIsUserMinting(true);
      if (connected && premiumCandyMachine?.program && publicKey) {
        let setupMint: SetupState | undefined;
        if (needTxnSplit && setupTxn === undefined) {
          setAlertState({
            open: true,
            message: "Please sign account setup transaction",
            severity: "info",
          });
          setupMint = await createAccountsForMint(
            premiumCandyMachine,
            publicKey
          );
          let status: any = { err: true };
          if (setupMint.transaction) {
            status = await awaitTransactionSignatureConfirmation(
              setupMint.transaction,
              props.txTimeout,
              props.connection,
              true
            );
          }
          if (status && !status.err) {
            setSetupTxn(setupMint);
            setAlertState({
              open: true,
              message:
                "Setup transaction succeeded! Please sign minting transaction",
              severity: "info",
            });
          } else {
            setAlertState({
              open: true,
              message: "Mint failed! Please try again!",
              severity: "error",
            });
            setIsUserMinting(false);
            return;
          }
        } else {
          setAlertState({
            open: true,
            message: "Please sign minting transaction",
            severity: "info",
          });
        }

        const mintResult = await mintOneToken(
          premiumCandyMachine,
          publicKey,
          beforeTransactions,
          afterTransactions,
          setupMint ?? setupTxn
        );

        let status: any = { err: true };
        let metadataStatus = null;
        if (mintResult) {
          status = await awaitTransactionSignatureConfirmation(
            mintResult.mintTxId,
            props.txTimeout,
            props.connection,
            true
          );

          metadataStatus =
            await premiumCandyMachine.program.provider.connection.getAccountInfo(
              mintResult.metadataKey,
              "processed"
            );
          console.log("Metadata status: ", !!metadataStatus);
        }

        if (status && !status.err && metadataStatus) {
          // manual update since the refresh might not detect
          // the change immediately
          const remaining = itemsRemainingPremium! - 1;
          setItemsRemainingPremium(remaining);
          setIsActive((premiumCandyMachine.state.isActive = remaining > 0));
          premiumCandyMachine.state.isSoldOut = remaining === 0;
          setSetupTxn(undefined);
          setAlertState({
            open: true,
            message: "Congratulations! Mint succeeded!",
            severity: "success",
            hideDuration: 7000,
          });
          refreshPremiumCandyMachineState("processed");
        } else if (status && !status.err) {
          setAlertState({
            open: true,
            message:
              "Mint likely failed! Anti-bot SOL 0.01 fee potentially charged! Check the explorer to confirm the mint failed and if so, make sure you are eligible to mint before trying again.",
            severity: "error",
            hideDuration: 8000,
          });
          refreshPremiumCandyMachineState();
        } else {
          setAlertState({
            open: true,
            message: "Mint failed! Please try again!",
            severity: "error",
          });
          refreshPremiumCandyMachineState();
        }
      }
    } catch (error: any) {
      let message = error.msg || "Minting failed! Please try again!";
      if (!error.msg) {
        if (!error.message) {
          message = "Transaction timeout! Please try again.";
        } else if (error.message.indexOf("0x137")) {
          console.log(error);
          message = `SOLD OUT!`;
        } else if (error.message.indexOf("0x135")) {
          message = `Insufficient funds to mint. Please fund your wallet.`;
        }
      } else {
        if (error.code === 311) {
          console.log(error);
          message = `SOLD OUT!`;
          window.location.reload();
        } else if (error.code === 312) {
          message = `Minting period hasn't started yet.`;
        }
      }

      setAlertState({
        open: true,
        message,
        severity: "error",
      });
      // updates the candy machine state to reflect the latest
      // information on chain
      refreshPremiumCandyMachineState();
    } finally {
      setIsUserMinting(false);
    }
  };

  const toggleStandardMintButton = () => {
    let active = !isActive || isPresale;

    if (active) {
      if (standardCandyMachine!.state.isWhitelistOnly && !isWhitelistUser) {
        active = false;
      }
      if (endDate && Date.now() >= endDate.getTime()) {
        active = false;
      }
    }

    if (
      isPresale &&
      standardCandyMachine!.state.goLiveDate &&
      standardCandyMachine!.state.goLiveDate.toNumber() <=
        new Date().getTime() / 1000
    ) {
      setIsPresale((standardCandyMachine!.state.isPresale = false));
    }

    setIsActive((standardCandyMachine!.state.isActive = active));
  };

  useEffect(() => {
    refreshStandardCandyMachineState();
    refreshPremiumCandyMachineState();
  }, [
    anchorWallet,
    props.candyMachineIdStandard,
    props.candyMachineIdPremium,
    props.connection,
    refreshStandardCandyMachineState,
    refreshPremiumCandyMachineState,
  ]);

  useEffect(() => {
    (function loop() {
      setTimeout(() => {
        refreshStandardCandyMachineState();
        refreshPremiumCandyMachineState();
        loop();
      }, 20000);
    })();
  }, [refreshStandardCandyMachineState, refreshPremiumCandyMachineState]);

  return (
    <Container style={{ marginTop: 100 }}>
      <Container maxWidth="xs" style={{ position: "relative" }}>
        <Paper
          style={{
            padding: 24,
            paddingBottom: 10,
            backgroundColor: "#151A1F",
            borderRadius: 6,
          }}
        >
          {/* Standard Mint */}
          {!connected ? (
            <ConnectButton
              onClick={(e) => {
                if (
                  wallet?.adapter.name === SolanaMobileWalletAdapterWalletName
                ) {
                  connect();
                  e.preventDefault();
                }
              }}
            >
              Connect Wallet
            </ConnectButton>
          ) : (
            <>
              {standardCandyMachine && (
                // Remaining , Price and Live info
                <Grid
                  container
                  direction="row"
                  justifyContent="center"
                  wrap="nowrap"
                >
                  <Grid item xs={3}>
                    <Typography variant="body2" color="textSecondary">
                      Remaining
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{
                        fontWeight: "bold",
                      }}
                    >
                      {`${itemsRemainingStandard}`}
                    </Typography>
                  </Grid>
                  <Grid item xs={4}>
                    <Typography variant="body2" color="textSecondary">
                      {isWhitelistUser && discountPrice
                        ? "Standard Discount Price"
                        : "Standard Price"}
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{ fontWeight: "bold" }}
                    >
                      {isWhitelistUser && discountPrice
                        ? `◎ ${formatNumber.asNumber(discountPrice)}`
                        : `◎ ${formatNumber.asNumber(
                            standardCandyMachine.state.price
                          )}`}
                    </Typography>
                  </Grid>
                  <Grid item xs={5}>
                    {isActive && endDate && Date.now() < endDate.getTime() ? (
                      <>
                        <MintCountdown
                          key="endSettings"
                          date={getCountdownDate(standardCandyMachine)}
                          style={{ justifyContent: "flex-end" }}
                          status="COMPLETED"
                          onComplete={toggleStandardMintButton}
                        />
                        <Typography
                          variant="caption"
                          align="center"
                          display="block"
                          style={{ fontWeight: "bold" }}
                        >
                          TO END OF MINT
                        </Typography>
                      </>
                    ) : (
                      <>
                        <MintCountdown
                          key="goLive"
                          date={getCountdownDate(standardCandyMachine)}
                          style={{ justifyContent: "flex-end" }}
                          status={
                            standardCandyMachine?.state?.isSoldOut ||
                            (endDate && Date.now() > endDate.getTime())
                              ? "COMPLETED"
                              : isPresale
                              ? "PRESALE"
                              : "LIVE"
                          }
                          onComplete={toggleStandardMintButton}
                        />
                      </>
                    )}
                  </Grid>
                </Grid>
              )}

              {premiumCandyMachine && (
                // Remaining , Price and Live info
                <Grid
                  container
                  direction="row"
                  justifyContent="center"
                  wrap="nowrap"
                >
                  <Grid item xs={3}>
                    <Typography variant="body2" color="textSecondary">
                      Remaining
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{
                        fontWeight: "bold",
                      }}
                    >
                      {`${itemsRemainingPremium}`}
                    </Typography>
                  </Grid>
                  <Grid item xs={4}>
                    <Typography variant="body2" color="textSecondary">
                      {isWhitelistUser && discountPrice
                        ? "Premium Discount Price"
                        : "Premium Price"}
                    </Typography>
                    <Typography
                      variant="h6"
                      color="textPrimary"
                      style={{ fontWeight: "bold" }}
                    >
                      {isWhitelistUser && discountPrice
                        ? `◎ ${formatNumber.asNumber(discountPrice)}`
                        : `◎ ${formatNumber.asNumber(
                            premiumCandyMachine.state.price
                          )}`}
                    </Typography>
                  </Grid>
                  <Grid item xs={5}>
                    {isActive && endDate && Date.now() < endDate.getTime() ? (
                      <>
                        <MintCountdown
                          key="endSettings"
                          date={getCountdownDate(premiumCandyMachine)}
                          style={{ justifyContent: "flex-end" }}
                          status="COMPLETED"
                          onComplete={toggleStandardMintButton}
                        />
                        <Typography
                          variant="caption"
                          align="center"
                          display="block"
                          style={{ fontWeight: "bold" }}
                        >
                          TO END OF MINT
                        </Typography>
                      </>
                    ) : (
                      <>
                        {isPresale &&
                          premiumCandyMachine.state.goLiveDate &&
                          premiumCandyMachine.state.goLiveDate.toNumber() >
                            new Date().getTime() / 1000 && (
                            <Typography
                              variant="caption"
                              align="center"
                              display="block"
                              style={{ fontWeight: "bold" }}
                            >
                              UNTIL PUBLIC MINT
                            </Typography>
                          )}
                      </>
                    )}
                  </Grid>
                </Grid>
              )}

              {/* Standard Mint Container */}
              <MintContainer>
                {standardCandyMachine?.state.isActive &&
                standardCandyMachine?.state.gatekeeper &&
                publicKey &&
                anchorWallet?.signTransaction ? (
                  <GatewayProvider
                    wallet={{
                      publicKey:
                        publicKey || new PublicKey(CANDY_MACHINE_PROGRAM),
                      signTransaction: anchorWallet.signTransaction,
                    }}
                    gatekeeperNetwork={
                      standardCandyMachine?.state?.gatekeeper?.gatekeeperNetwork
                    }
                    clusterUrl={rpcUrl}
                    cluster={cluster}
                    options={{ autoShowModal: false }}
                  >
                    <MintButton
                      candyMachine={standardCandyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={(val) => setIsUserMinting(val)}
                      onMint={onStandardMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                      isStandard={true}
                    />
                    <Box justifyContent="center">
                      <CrossmintPayButton
                        // clientId="8c1023cc-7c03-4fe7-aeb0-c9645c5be497"
                        clientId={crossMintStandardKey}
                        mintConfig={{ type: "candy-machine" }}
                        environment="production"
                        paymentMethod="fiat"
                        style={{ width: "100%" }}
                      />
                      {/* <CrossmintPayButton
                        clientId="8c1023cc-7c03-4fe7-aeb0-c9645c5be497"
                        mintConfig={{ type: "candy-machine" }}
                        environment="staging"
                        paymentMethod="ETH"
                        style={{ width: "100%" }}
                      /> */}
                    </Box>
                  </GatewayProvider>
                ) : (
                  <Box gap={4} justifyContent="center">
                    <MintButton
                      candyMachine={standardCandyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={(val) => setIsUserMinting(val)}
                      onMint={onStandardMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                      isStandard={true}
                    />
                    <CrossmintPayButton
                      // clientId="8c1023cc-7c03-4fe7-aeb0-c9645c5be497"
                      clientId={crossMintStandardKey}
                      mintConfig={{ type: "candy-machine" }}
                      environment="production"
                      paymentMethod="fiat"
                      style={{ width: "100%" }}
                    />
                    {/* <CrossmintPayButton
                      clientId="8c1023cc-7c03-4fe7-aeb0-c9645c5be497"
                      mintConfig={{ type: "candy-machine" }}
                      environment="staging"
                      paymentMethod="ETH"
                      style={{ width: "100%" }}
                    /> */}
                  </Box>
                )}
              </MintContainer>

              {/* Premium Mint Container */}
              <MintContainer>
                {premiumCandyMachine?.state.isActive &&
                premiumCandyMachine?.state.gatekeeper &&
                publicKey &&
                anchorWallet?.signTransaction ? (
                  <GatewayProvider
                    wallet={{
                      publicKey:
                        publicKey || new PublicKey(CANDY_MACHINE_PROGRAM),
                      signTransaction: anchorWallet.signTransaction,
                    }}
                    gatekeeperNetwork={
                      premiumCandyMachine?.state?.gatekeeper?.gatekeeperNetwork
                    }
                    clusterUrl={rpcUrl}
                    cluster={cluster}
                    options={{ autoShowModal: false }}
                  >
                    <MintButton
                      candyMachine={premiumCandyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={(val) => setIsUserMinting(val)}
                      onMint={onPremiumMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                      isStandard={false}
                    />
                    <Box justifyContent="center">
                      <CrossmintPayButton
                        // clientId="d6a98c90-2467-425a-af52-51f3c0a4a2b1"
                        clientId={crossMintPremiumKey}
                        mintConfig={{ type: "candy-machine" }}
                        environment="production"
                        paymentMethod="fiat"
                        style={{ width: "100%" }}
                      />
                      {/* <CrossmintPayButton
                        clientId="d6a98c90-2467-425a-af52-51f3c0a4a2b1"
                        mintConfig={{ type: "candy-machine" }}
                        environment="staging"
                        paymentMethod="ETH"
                        style={{ width: "100%" }}
                      /> */}
                    </Box>
                  </GatewayProvider>
                ) : (
                  <Box justifyContent="center">
                    <MintButton
                      candyMachine={premiumCandyMachine}
                      isMinting={isUserMinting}
                      setIsMinting={(val) => setIsUserMinting(val)}
                      onMint={onPremiumMint}
                      isActive={
                        isActive ||
                        (isPresale && isWhitelistUser && isValidBalance)
                      }
                      isStandard={false}
                    />
                    <CrossmintPayButton
                      // clientId="d6a98c90-2467-425a-af52-51f3c0a4a2b1"
                      clientId={crossMintPremiumKey}
                      mintConfig={{ type: "candy-machine" }}
                      environment="production"
                      paymentMethod="fiat"
                      style={{ width: "100%" }}
                    />
                    {/* <CrossmintPayButton
                      clientId="d6a98c90-2467-425a-af52-51f3c0a4a2b1"
                      mintConfig={{ type: "candy-machine" }}
                      environment="staging"
                      paymentMethod="ETH"
                      style={{ width: "100%" }}
                    /> */}
                  </Box>
                )}
              </MintContainer>
            </>
          )}

          <Typography
            variant="caption"
            align="center"
            display="block"
            style={{ marginTop: 7, color: "grey" }}
          >
            Powered by METAPLEX
          </Typography>
        </Paper>
      </Container>

      <Snackbar
        open={alertState.open}
        autoHideDuration={
          alertState.hideDuration === undefined ? 6000 : alertState.hideDuration
        }
        onClose={() => setAlertState({ ...alertState, open: false })}
      >
        <Alert
          onClose={() => setAlertState({ ...alertState, open: false })}
          severity={alertState.severity}
        >
          {alertState.message}
        </Alert>
      </Snackbar>
    </Container>
  );
};

const getCountdownDate = (
  candyMachine: CandyMachineAccount
): Date | undefined => {
  if (
    candyMachine.state.isActive &&
    candyMachine.state.endSettings?.endSettingType.date
  ) {
    return toDate(candyMachine.state.endSettings.number);
  }

  return toDate(
    candyMachine.state.goLiveDate
      ? candyMachine.state.goLiveDate
      : candyMachine.state.isPresale
      ? new anchor.BN(new Date().getTime() / 1000)
      : undefined
  );
};

export default MultipleHome;

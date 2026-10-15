# Deploying BarreFree on a Windows Server VPS

This guide puts BarreFree on a rented Windows Server 2022 or 2025 VPS and publishes it on your
own domain through a Cloudflare Tunnel. It assumes you can follow commands but have never run a
server. Do the sections in order and run each check before you move on.

**Where each command runs.** The first line of every command block says where to type it:

- `# PowerShell (Administrator)`: Windows PowerShell started with _Run as administrator_ on the
  VPS (connect with Remote Desktop; Start, type PowerShell, right-click, _Run as administrator_).
- `# Ubuntu`: the Ubuntu shell inside WSL. From section 4 on, you open it from PowerShell with
  `wsl ~`.

The line starts with `#`, so pasting it along does no harm in either shell. Keep two windows
open: one PowerShell for Windows commands, and one PowerShell in which you typed `wsl ~`, which
becomes your Ubuntu window. You can tell them apart by the prompt: PowerShell shows
`PS C:\...>`; Ubuntu shows `<linux-user>@<server-name>:~$`. Typing `exit` in the Ubuntu window
closes only that shell; once sections 4 and 5 are done, Ubuntu and the app keep running. Always
use the same Windows account: WSL belongs to the account that installs it (see
[section 5](#5-keep-everything-running-after-a-reboot)).

**Blocks that use `sudo`.** `sudo` asks for your Linux password (section 3.2) the first time and
again after a while. Before you paste a block of several lines that uses `sudo`, run `sudo -v` on
its own and type your password. Otherwise sudo's password question swallows the pasted lines
that follow.

Replace anything in `<angle brackets>` with your own value.

**A word of honesty.** This is a well-trodden setup, but neither Microsoft nor Docker supports
it officially for production. Microsoft says WSL "has been designed and built to use with inner
loop development workflows" ([WSL FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq)), and
Docker's install pages never mention WSL
([Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)). Everything below is
built from official documentation, and the places where the documentation is silent are marked
**Check on your server**. The most important check is the reboot test in
[section 5](#5-keep-everything-running-after-a-reboot).

## Contents

1. [Overview](#1-overview)
2. [Requirements and sizing](#2-requirements-and-sizing)
3. [Install WSL 2 and Ubuntu 24.04](#3-install-wsl-2-and-ubuntu-2404)
4. [Configure WSL](#4-configure-wsl)
5. [Keep everything running after a reboot](#5-keep-everything-running-after-a-reboot)
6. [Install Docker Engine in Ubuntu](#6-install-docker-engine-in-ubuntu)
7. [Get BarreFree running](#7-get-barrefree-running)
8. [Publish with Cloudflare Tunnel](#8-publish-with-cloudflare-tunnel)
9. [Security notes](#9-security-notes)
10. [Operations](#10-operations)
11. [Troubleshooting](#11-troubleshooting)
12. [What you must check yourself](#12-what-you-must-check-yourself)

---

## 1. Overview

```text
 Visitors (any browser, HTTPS)
        │
        ▼
 Cloudflare (your domain, TLS certificate, optional login with Cloudflare Access)
        ▲
        │  outbound-only connections, started from the VPS (port 7844)
        │
┌─ Windows Server VPS ───────────────────────────────────────────────────────┐
│  WSL 2 (a small Linux virtual machine managed by Windows)                  │
│  └─ Ubuntu 24.04 (systemd)                                                 │
│     └─ Docker Engine + docker compose, project "barrefree"                 │
│        ├─ cloudflared ──▶ http://api:8000                                  │
│        ├─ api     web app + /api, published on 127.0.0.1:8000 only         │
│        └─ worker  audio analysis; model weights in a volume                │
└────────────────────────────────────────────────────────────────────────────┘
```

**No inbound ports.** `cloudflared` opens outbound connections to Cloudflare, and visitors reach
the app through them. Cloudflare recommends blocking all inbound traffic to the origin
([Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/)). The API
container is published on `127.0.0.1` only, so nothing on the internet can reach it directly.
The only inbound port your VPS needs is the one you administer it with (Remote Desktop).

**What you will set up:**

- WSL 2 with Ubuntu 24.04 and systemd, sized for the analysis worker.
- A scheduled task that starts WSL at boot without anyone logging in.
- Docker Engine (not Docker Desktop, which "is not supported on server versions of Windows",
  [Docker](https://docs.docker.com/desktop/setup/install/windows-install/)).
- BarreFree from this repository: the `api` and `worker` containers.
- A Cloudflare Tunnel (`cloudflared` container) that serves the app at `https://<your hostname>`,
  optionally behind a Cloudflare Access login.

**Time needed.** Plan an afternoon: roughly 2 to 3 hours, most of it waiting for reboots,
downloads and the first image build. This is an estimate; it depends on the VPS and its
connection.

---

## 2. Requirements and sizing

### 2.1 Size of the VPS

The numbers below come from [docs/benchmarks.md](benchmarks.md), measured on a **4-core sandbox**
(Intel Xeon 2.10 GHz), not on a VPS. Measure your own server once BarreFree runs (section 7.6).

What the worker needs, per song (one job runs at a time):

| Song length | Default job (time / peak memory) | With BTC, separation and notes (time / peak memory) |
| ----------- | -------------------------------- | --------------------------------------------------- |
| 1 minute    | about 10 s / 0.85 GB             | about 34 s / 1.4 GB                                 |
| 3 minutes   | about 22 s / 1.0 GB              | about 1.6 min / 1.5 GB                              |
| 15 minutes  | about 1.5 min / 2.0 GB           | about 8 min / 2.4 GB                                |

"Default job" means an upload with the upload form's defaults: chord recognizer _Default_
(Chordino), with **Separate the instruments first** and **Also write out the notes (tab,
experimental)** unchecked. The right-hand column has both boxes checked and BTC chosen as the
recognizer.

(Time = model loading + the "Decode" row + the "Analysis of the decoded song" rows of the
benchmark: every job first decodes the upload and writes the playback copy.) Source separation
(Demucs) is the expensive, opt-in step: it keeps all 4 cores busy for about 0.4 × the song length.
The compose file caps the worker at 4 GB and the API at 1 GB (`WORKER_MEMORY_LIMIT`,
`API_MEMORY_LIMIT`), which leaves headroom over the measured peaks.

|      | Minimum                                 | Recommended |
| ---- | --------------------------------------- | ----------- |
| vCPU | 4                                       | 4 to 8      |
| RAM  | 8 GB (Server 2022), 12 GB (Server 2025) | 16 GB       |
| Disk | 80 GB                                   | 120 GB      |

How these are derived:

- **RAM.** WSL needs at least the containers' limits (4 GB + 1 GB) plus 1 GB for Ubuntu, Docker
  and `cloudflared`: 6 GB. Windows needs its own share: Microsoft's minimum for Server with
  Desktop Experience is 2 GB, and for Windows Server 2025 it recommends 4 GB
  ([hardware requirements](https://learn.microsoft.com/en-us/windows-server/get-started/hardware-requirements)).
  On Server 2022, 8 GB works (6 + 2). On Server 2025, 8 GB cannot satisfy both Microsoft's
  4 GB recommendation and the containers' limits: choose 12 GB or more, or knowingly run Windows
  at its 2 GB minimum, which can make Remote Desktop slow. With 16 GB both sides are
  comfortable.
- **CPU.** Separation uses every core it gets; with fewer than 4 it should still work, only
  more slowly (not measured).
- **Disk.** Microsoft calls 32 GB the absolute minimum for Windows itself
  ([hardware requirements](https://learn.microsoft.com/en-us/windows-server/get-started/hardware-requirements)).
  On top of that comes the WSL virtual disk with Ubuntu, the BarreFree image (3.15 GB on disk,
  measured on a development machine: Docker's containerd image store keeps layers both
  compressed and unpacked, [Docker](https://docs.docker.com/engine/storage/containerd/)),
  Docker's build cache (it reached 15.65 GB there after repeated builds; it can be cleaned, see
  section 10.4), about 180 MB of model weights and the temporary job files. WSL's 2 to 4 GB swap
  file is a separate file on the Windows disk (`%Temp%\swap.vhdx` by default,
  [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).

### 2.2 Windows Server version

- **Windows Server 2022 or 2025.** WSL 2 needs Windows build 18362 or later; Server 2022 is build
  20348 and Server 2025 is build 26100. Server 2019 (build 17763) can only run WSL 1
  ([manual install](https://learn.microsoft.com/en-us/windows/wsl/install-manual),
  [release info](https://learn.microsoft.com/en-us/windows/release-health/windows-server-release-info)).
- **Server 2022:** WSL 2 arrived through the June 2022 Windows update, and Microsoft says to
  confirm that KB5014678 is installed
  ([announcement](https://devblogs.microsoft.com/commandline/wsl-2-distros-are-now-supported-on-windows-server/)).
  Install all Windows updates before you start. (That later cumulative updates include it is
  likely but not stated by Microsoft.) You do not need to look the update up by name: the
  practical test is section 3, where `wsl -l -v` must show VERSION 2.
- Standard or Datacenter: nothing found suggests a difference.

**If you can still choose:** WSL's own test pipeline runs on both versions
([WSL test pipeline](https://github.com/microsoft/WSL/blob/f5c1d96c6a0923e8ce57568feadf91e427e15d43/.pipelines/test-stage.yml)).
Server 2022 is the version Microsoft's `wsl.conf` page names, but its mainstream support has
ended (extended support runs until 2031-10-14). Server 2025 is supported longer (mainstream until
2029-11-13, extended until 2034-11-14), but Microsoft recommends 4 GB of memory for Windows
itself (section 2.1), and it has one more open point (section 12, item 3)
([release info](https://learn.microsoft.com/en-us/windows/release-health/windows-server-release-info)).

Check your version:

```powershell
# PowerShell (Administrator)
systeminfo | Select-String "^OS Name","^OS Version"
```

### 2.3 Nested virtualization (the requirement that decides everything)

Your VPS is itself a virtual machine, and WSL 2 runs another small virtual machine inside it.
That only works if the provider exposes **nested virtualization** to your VM; only the provider
can switch it on
([WSL FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq),
[enable nested virtualization](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization)).
WSL 2 also needs a CPU with Second Level Address Translation (SLAT)
([WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting)).

Microsoft supports this only when the provider's hypervisor is Hyper-V. On other hypervisors
(KVM, Xen, VMware) it may work but Microsoft does not test it
([nested virtualization](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/nested-virtualization)).

**WSL 1 is not a fallback.** WSL 1 has no real Linux kernel, no full system-call compatibility and
no systemd, and Microsoft names Docker among the things WSL 2's compatibility makes possible
([compare WSL versions](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)). No page
says "Docker cannot run on WSL 1" in so many words, but without a real kernel and systemd it
cannot run the way this guide needs.

**How to check from Windows.** There is no reliable test from inside the VM:

- `Get-ComputerInfo -Property "HyperV*"` shows `HyperVisorPresent`, but Microsoft documents the
  `HyperVRequirement*` values as meaningful only when no hypervisor is present, so inside a VPS
  they say nothing
  ([reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.powershell.commands.computerinfo.hypervrequirementvirtualizationfirmwareenabled)).
- Sysinternals Coreinfo can wrongly report VT-x/AMD-V as missing inside a VM
  ([Coreinfo](https://learn.microsoft.com/en-us/sysinternals/downloads/coreinfo)).

The practical test is section 3 itself. If nested virtualization is missing, you will see one of
these:

- `wsl --status` prints _"WSL2 is unable to start since virtualization is not enabled on this
  machine"_ (current WSL text,
  [WSL source](https://github.com/microsoft/WSL/blob/f5c1d96c6a0923e8ce57568feadf91e427e15d43/localization/strings/en-US/Resources.resw);
  older builds may word it differently).
- Installing Ubuntu fails with error **0x80370102**
  ([WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting)) or with
  `HCS_E_HYPERV_NOT_INSTALLED` (seen in a
  [community report](https://learn.microsoft.com/en-gb/answers/questions/2143749/unable-to-setup-nestedvirtualization-in-windows-vm)).

**What some providers document** (re-checked 2026-10-14; ask yours even if it is listed):

| Provider              | Nested virtualization for WSL 2                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure                 | Supported on Dv3, Dv5/Dsv5, Dasv5, Dsv6, Dasv6, Dasv7; **not** on the burstable Bsv2/Basv2 ([Dv5 sizes](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dv5-series)). Create the VM with Security type **Standard**: Microsoft's WSL and Hyper-V pages say Trusted Launch blocks nested virtualization ([enable nested virtualization](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/enable-nested-virtualization)). |
| AWS EC2               | Only on listed instance families (M7i, C7i, R7i, M8i, C8i, R8i and a few more), enabled through CPU options at launch or on a stopped instance; AWS names WSL2 as a use case ([AWS docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)).                                                                                                                                                                                         |
| Google Cloud          | Only KVM is supported inside a VM, Hyper-V is not, so WSL 2 is not a supported scenario ([GCE docs](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview)).                                                                                                                                                                                                                                                                                    |
| Hetzner Cloud         | No nested virtualization ([Hetzner FAQ](https://docs.hetzner.com/cloud/servers/faq/)).                                                                                                                                                                                                                                                                                                                                                                                        |
| OVHcloud Public Cloud | Exposes VT-x, but warns that a live migration may crash the guest kernel ([OVHcloud FAQ](https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/faq-pci)). OVHcloud VPS: no statement.                                                                                                                                                                                                                                                                             |
| Contabo               | VPS: not supported. VDS: "Hyper-V does not run on VDS with Windows Server" ([Contabo VPS](https://docs.contabo.com/docs/servers-hosting/vps/), [Contabo VDS](https://docs.contabo.com/docs/servers-hosting/max-performance-vps/)).                                                                                                                                                                                                                                            |

**What to ask your provider** (copy and send):

> I want to run WSL 2 (Hyper-V's Virtual Machine Platform) inside my Windows Server VM.
> Is nested virtualization (VT-x/AMD-V with EPT/NPT) exposed to the VM? Which hypervisor do you
> use? Can my VM be live-migrated, and does that affect nested virtualization?

If the answer is no, stop here: use a provider that says yes, or a Linux VPS (where the same
`docker compose` commands work without WSL).

You do **not** need the Hyper-V server role: Microsoft's Windows Server instructions enable only
the _Windows Subsystem for Linux_ and _Virtual Machine Platform_ features
([install on Windows Server](https://learn.microsoft.com/en-us/windows/wsl/install-on-server)).

### 2.4 What to have ready before you start

- Your VPS provider's written answer on nested virtualization (section 2.3).
- The Windows Administrator password (the one you use for Remote Desktop). Section 5 stores it
  in a scheduled task.
- A domain on Cloudflare that uses Cloudflare's nameservers (full setup; the Free plan cannot
  use the partial setup, section 8.1). Start this now: it involves your domain registrar and may
  not be instant. Check the domain's status in the Cloudflare dashboard.
- A password manager or a safe note for the Linux user name and password (section 3.2) and the
  tunnel token (section 8.2).
- About 3 hours.

---

## 3. Install WSL 2 and Ubuntu 24.04

### 3.1 Install WSL without a distribution

1. Install WSL and its Windows features
   ([install on Windows Server](https://learn.microsoft.com/en-us/windows/wsl/install-on-server),
   [basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)):

   ```powershell
   # PowerShell (Administrator)
   wsl --install --no-distribution
   ```

   If the command is not accepted, enable the features by hand (step 5), restart, run
   `wsl --update`, and continue with step 3.

   Do not run a plain `wsl --install`: it would install the default Ubuntu, which is now
   Ubuntu 26.04, not 24.04
   ([WSL distribution list](https://github.com/microsoft/WSL/blob/f5c1d96c6a0923e8ce57568feadf91e427e15d43/distributions/DistributionInfo.json)).

2. Restart (the installation needs it,
   [Microsoft](https://learn.microsoft.com/en-us/windows/wsl/setup/environment)):

   ```powershell
   # PowerShell (Administrator)
   Restart-Computer
   ```

3. Reconnect and check which WSL you have:

   ```powershell
   # PowerShell (Administrator)
   wsl --version
   wsl --status
   ```

   `wsl --version` must print a _WSL version_ line. You need **at least 2.5.4** for this guide:
   Ubuntu 24.04 needs 2.4.10 or later
   ([Canonical](https://ubuntu.com/wsl/docs/latest/howto/install-ubuntu-wsl2/)), and the idle
   setting in section 4 arrived in 2.5.4
   ([release notes](https://github.com/microsoft/WSL/releases/tag/2.5.4)). On 2026-10-14 the
   latest release was 3.0.3 ([WSL releases](https://github.com/microsoft/WSL/releases)).

   If `wsl --status` mentions that virtualization is not enabled, see section 2.3.

4. If `wsl --version` says the option is invalid, you have the old built-in WSL, which also
   lacks systemd support (systemd needs WSL 0.67.6 or later,
   [systemd in WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)). Update it:

   ```powershell
   # PowerShell (Administrator)
   wsl --update
   ```

   Windows Server has no Microsoft Store; if the update fails, try
   `wsl --update --web-download`, which downloads from GitHub instead
   ([compare WSL versions](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)).
   If that fails too, install the MSI from GitHub
   ([offline install](https://learn.microsoft.com/en-us/windows/wsl/install)). Take the file
   name of the release marked _Latest_ from the
   [releases page](https://github.com/microsoft/WSL/releases); for 3.0.3:

   ```powershell
   # PowerShell (Administrator)
   $ProgressPreference = 'SilentlyContinue'
   Invoke-WebRequest https://github.com/microsoft/WSL/releases/download/3.0.3/wsl.3.0.3.0.x64.msi -OutFile $env:TEMP\wsl.msi -UseBasicParsing
   Start-Process msiexec.exe -ArgumentList "/i `"$env:TEMP\wsl.msi`"" -Wait
   ```

   Follow the installer window; PowerShell waits until it closes. Then run `wsl --version`
   again.

5. Make sure the Windows features are on
   ([manual install](https://learn.microsoft.com/en-us/windows/wsl/install-manual)). Virtual
   Machine Platform is always required. On Server 2022 WSL also requires the _Windows Subsystem
   for Linux_ feature; on Server 2025 it is optional
   ([WSL source](https://github.com/microsoft/WSL/blob/f5c1d96c6a0923e8ce57568feadf91e427e15d43/src/windows/common/WslInstall.cpp)):

   ```powershell
   # PowerShell (Administrator)
   Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux | Select-Object State
   Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform | Select-Object State
   ```

   On Server 2022 both must say `Enabled`; on Server 2025 at least the second. If not, enable
   them and restart:

   ```powershell
   # PowerShell (Administrator)
   Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux, VirtualMachinePlatform
   Restart-Computer
   ```

### 3.2 Install Ubuntu 24.04

1. Install it by its exact name, `Ubuntu-24.04`
   ([install docs](https://learn.microsoft.com/en-us/windows/wsl/install)):

   ```powershell
   # PowerShell (Administrator)
   wsl --install Ubuntu-24.04
   ```

   On Windows Server, current WSL downloads the distribution from the web by default, no Store
   needed (per [WSL's source](https://github.com/microsoft/WSL/blob/f5c1d96c6a0923e8ce57568feadf91e427e15d43/src/windows/common/WslClient.cpp)).
   If the download stays at 0.0 %, install from the image file (step 2). (Microsoft's usual tip,
   `--web-download`, is already the default on Windows Server in current WSL.)

   Optional, and only if C: is too small for the disk numbers in section 2.1: to put the Linux
   disk on a data drive instead of `C:`, add `--location D:\WSL\Ubuntu-24.04`
   ([basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)).
   Microsoft's troubleshooting page still says WSL only runs on the system drive, so if you try
   this, test it.

2. **If the download fails**, install from Canonical's image file instead
   ([Canonical](https://ubuntu.com/wsl/docs/latest/howto/install-ubuntu-wsl2/)). Check the
   current file name on [releases.ubuntu.com/noble](https://releases.ubuntu.com/noble/); on
   2026-10-14 it was `ubuntu-24.04.5-wsl-amd64.wsl`:

   ```powershell
   # PowerShell (Administrator)
   cd $env:TEMP
   $ProgressPreference = 'SilentlyContinue'
   Invoke-WebRequest https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl -OutFile ubuntu-24.04.5-wsl-amd64.wsl -UseBasicParsing
   (Get-FileHash .\ubuntu-24.04.5-wsl-amd64.wsl -Algorithm SHA256).Hash
   ```

   Compare the hash with the line for that file in
   [SHA256SUMS](https://releases.ubuntu.com/noble/SHA256SUMS) (for 24.04.5:
   `bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e`). If it matches:

   ```powershell
   # PowerShell (Administrator)
   wsl --install --from-file .\ubuntu-24.04.5-wsl-amd64.wsl --name Ubuntu-24.04
   ```

3. **First start.** Ubuntu starts right after the installation and asks for a new **Linux user
   name and password**. This account has nothing to do with your Windows account; it gets
   `sudo` rights ([Microsoft](https://learn.microsoft.com/en-us/windows/wsl/setup/environment)).
   Use a short lowercase name without spaces (for example `guitar`). Write the name and the
   password down: later steps call the name `<linux-user>` (`whoami` prints it), and `sudo` asks
   for the password. (Nothing appears on screen while you type a password; that is normal.)

4. Still in the Ubuntu shell, update the system:

   ```bash
   # Ubuntu
   sudo apt update && sudo apt upgrade -y
   ```

   When it has finished, leave Ubuntu with `exit`.

5. Check that it is a WSL **2** distribution and make it the default:

   ```powershell
   # PowerShell (Administrator)
   wsl -l -v
   wsl --set-default Ubuntu-24.04
   ```

   The `VERSION` column must show `2`. If you forget the Linux password later:
   `wsl -d Ubuntu-24.04 -u root`, then `passwd <linux-user>`.

---

## 4. Configure WSL

There are two configuration files
([WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)):

- `/etc/wsl.conf` inside Ubuntu: settings for this distribution.
- `%UserProfile%\.wslconfig` in Windows: settings for the WSL virtual machine (memory, CPUs,
  idle shutdown). It belongs to the Windows account, so create it while logged in as the account
  that will run the boot task in section 5.

### 4.1 systemd and the default user (`/etc/wsl.conf`)

Open Ubuntu from PowerShell with `wsl ~`, which starts it in your Linux home directory
([basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands); Ubuntu-24.04 is
the default since section 3.2 step 5). `pwd` must print `/home/<linux-user>`, not a path under
`/mnt/c`. Use `wsl ~` every time this guide says "open Ubuntu".

Docker is started by systemd, which must be on
([systemd in WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)). The official Ubuntu
24.04.5 image already ships `/etc/wsl.conf` with `[boot] systemd=true` (checked by extracting
[the image](https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl) on 2026-10-14; later
point releases may differ). Check yours anyway:

```bash
# Ubuntu
cat /etc/wsl.conf
```

If it shows only `[boot]` and `systemd=true` (or nothing), replace it with the version below. It
also stores your Linux user as the default inside Ubuntu itself, so the setting survives a full
backup and restore with `wsl --export`/`--import` (section 10.5): the launcher's
`config --default-user` does not work for imported distributions
([basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)). Current WSL also
has `wsl --manage Ubuntu-24.04 --set-default-user <linux-user>`, but `/etc/wsl.conf` travels
with the backup ([user default](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)):

```bash
# Ubuntu
sudo tee /etc/wsl.conf <<EOF
[boot]
systemd=true

[user]
default=$USER
EOF
```

If the file already contained other lines, open it with `sudo nano /etc/wsl.conf` instead,
check that it has the `[boot]` and `systemd=true` lines, add the two `[user]` lines at the end
(with your Linux user name after `default=`), save with Ctrl+O, Enter, and quit with Ctrl+X.

Leave Ubuntu with `exit`: section 4.2 runs in PowerShell.

**Check on your server (Server 2025):** Microsoft's page says the `[boot]` section is "only
available on Windows 11 and Server 2022" and does not mention Server 2025. Current WSL treats
Server 2025 like Windows 11 and Microsoft runs WSL's tests on it
([WSL 3.0.3 notes](https://github.com/microsoft/WSL/releases/tag/3.0.3)), so it probably
works. The verification in 4.3 settles it.

### 4.2 Memory, CPUs, swap and idle shutdown (`.wslconfig`)

By default WSL may use 50 % of the server's memory and all its processors, with swap of 25 % of
that memory ([WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
50 % of 8 GB is less than the containers' limits (4 GB + 1 GB), so set it explicitly:

| VPS                    | `memory` | `processors`    | `swap` |
| ---------------------- | -------- | --------------- | ------ |
| 8 GB RAM, 4 vCPU       | `6GB`    | `4`             | `2GB`  |
| 12 GB RAM, 4 to 8 vCPU | `8GB`    | number of vCPUs | `3GB`  |
| 16 GB RAM, 4 to 8 vCPU | `12GB`   | number of vCPUs | `4GB`  |

The rule: `memory` must be at least the containers' limits + 1 GB (6 GB with the defaults), and
it must leave Windows at least 2 GB, Microsoft's minimum for Server with Desktop Experience. For
Server 2025 Microsoft recommends 4 GB, which an 8 GB VPS cannot give alongside these limits
(section 2.1): use 12 GB or more there, or accept the minimum. If you lower `memory`, lower
`WORKER_MEMORY_LIMIT` in `.env` (section 7.2) to match; if you raise `WORKER_MEMORY_LIMIT`,
raise `memory` too.

With `processors` equal to all vCPUs, a separation job keeps every core busy for minutes
(section 2.1), and Remote Desktop can feel slow meanwhile; that is expected. On 4 vCPUs you may
set `processors=3` to keep a core for Windows. Separation then takes longer (not measured).

**Idle shutdown.** WSL stops a distribution 15 seconds after the last WSL process using it exits
(`instanceIdleTimeout`, default 15000 ms), then the virtual machine 60 seconds later
(`vmIdleTimeout`). A running Docker does **not** count: systemd services do not keep WSL alive
([systemd in WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd)). Setting both to `-1`
turns the shutdown off. In current WSL, a distribution that never stops also keeps the virtual
machine up ([WSL source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/LxssUserSession.cpp)),
so `instanceIdleTimeout` is the setting that matters.

| Setting                         | Windows Server 2022 / 2025                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[general] instanceIdleTimeout` | No Windows-11-only note in the docs; needs WSL 2.5.4 or later.                                                                                                                                                                        |
| `[wsl2] vmIdleTimeout`          | Documented as "Only available on Windows 11". Current WSL reads it on every Windows version ([source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/LxssUserSession.cpp)), so it is included as a second layer. |

Write the file (the example is for an 8 GB / 4 vCPU server; use your values from the table):

```powershell
# PowerShell (Administrator)
@"
[general]
instanceIdleTimeout=-1

[wsl2]
memory=6GB
processors=4
swap=2GB
vmIdleTimeout=-1
"@ | Set-Content -Path "$env:USERPROFILE\.wslconfig" -Encoding ascii
Get-Content "$env:USERPROFILE\.wslconfig"
```

Leave these alone on Windows Server:

- `networkingMode`: keep the default (NAT). On Server 2025, `mirrored` mode has been reported to
  leave WSL with **no network at all** ([WSL issue 12486](https://github.com/microsoft/WSL/issues/12486)).
- `[experimental] autoMemoryReclaim`: keep the default (`dropCache`). Microsoft reported in 2023
  that the `gradual` mode broke the Docker daemon in early testing
  ([announcement](https://devblogs.microsoft.com/commandline/windows-subsystem-for-linux-september-2023-update/)).

### 4.3 Apply the changes and verify

Changes take effect only after WSL has **fully stopped**. Microsoft calls this the "8 second
rule": check with `wsl --list --running` before starting again
([WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).

1. Stop WSL and wait until nothing is running:

   ```powershell
   # PowerShell (Administrator)
   wsl --shutdown
   wsl --list --running
   ```

   Repeat the second command until it reports no running distributions.

2. Open Ubuntu again (PowerShell: `wsl ~`) and check systemd, memory and CPUs:

   ```bash
   # Ubuntu
   ps -p 1 -o comm=
   systemctl is-system-running
   free -h
   nproc
   ```

   Expected: `systemd`; `running` (or `degraded`, which only means some unit failed; list it with
   `systemctl --failed`); a total memory close to your `memory` value; your `processors` value.
   WSL waits for systemd to report running or degraded during start-up
   ([WSL systemd notes](https://github.com/microsoft/WSL/blob/3.0.3/doc/docs/technical-documentation/systemd.md)).
   (This is systemd's `degraded`; it has nothing to do with the app's `"status": "degraded"` in
   section 7.5.)

3. Check that the idle setting works on your Windows version. Leave Ubuntu with `exit`, wait a
   minute, and look:

   ```powershell
   # PowerShell (Administrator)
   Start-Sleep -Seconds 60
   wsl --list --running
   ```

   `Ubuntu-24.04` must still be listed. If it is gone, the idle setting is not honoured: check
   `wsl --version` (2.5.4 or later) and the `.wslconfig` contents, and rely on the keep-alive
   command of section 5, which holds WSL open on its own.

**From now on, after any change to either file:** `wsl --shutdown`, wait for
`wsl --list --running` to be empty, then start WSL again: with
`Start-ScheduledTask -TaskName 'BarreFree WSL'` once section 5 has created it (and check as in
the rule at the end of section 5.2); until then, with `wsl ~`.

---

## 5. Keep everything running after a reboot

Windows starts WSL only when someone runs a WSL command, and stops it when the user who started
it signs out. For a server you need WSL to start at boot with nobody logged in. Microsoft
documents no official way to do this. The method below combines documented Task Scheduler
features with what WSL's source code expects; **only a real reboot proves it works on your
server**.

Facts it relies on:

- **WSL is per Windows user.** Distributions are installed per Windows account and cannot be
  shared ([Microsoft](https://learn.microsoft.com/en-us/windows/wsl/setup/environment)). The
  task must run as the account that installed Ubuntu-24.04 and owns the `.wslconfig`.
- **Not as SYSTEM.** WSL refuses to run as LocalSystem ("Running WSL as local system is not
  supported.",
  [WSL source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/LxssUserSessionFactory.cpp)).
- **Signing out stops WSL.** WSL stops a user's distributions when that user logs off
  ([release notes, build 20211](https://learn.microsoft.com/en-us/windows/wsl/release-notes)).
  According to WSL's source code, WSL keeps one session per Windows user (elevated and normal
  windows and the task all share it), and that session ends when the Windows logon that first
  created it signs out. A session first created by a background task (session 0) is not tied to
  a Remote Desktop sign-in; it ends only when the WSL service stops
  ([WSL source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/LxssUserSessionFactory.cpp)).
  So WSL must be started by the task at boot, before you log in, and again after anything that
  restarts the WSL service, such as a WSL update (section 9.4).
- **Use `C:\Program Files\WSL\wsl.exe`.** Launching WSL from session 0 (background tasks, SSH)
  through `C:\Windows\System32\wsl.exe` is a known issue; Microsoft's workaround is to call the
  copy in `Program Files` directly
  ([Microsoft, Sept 2023](https://devblogs.microsoft.com/commandline/windows-subsystem-for-linux-september-2023-update/)).
- **Password logon.** "Run whether user is logged on or not" needs either a stored password or
  "Do not store password" (S4U), and S4U tasks have no access to the network
  ([logon types](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)).
  Whether that affects WSL is untested, so this guide stores the password. Such tasks need the
  _Log on as a batch job_ right, which Administrators have by default
  ([security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)).
- **No 3-day limit.** Task Scheduler stops a task after 72 hours unless its time limit is
  `PT0S` ([ExecutionTimeLimit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)).

The task runs `sleep infinity` inside Ubuntu. That keeps a WSL client attached, so WSL stays up
even if the idle setting were ignored; and `instanceIdleTimeout=-1` keeps it up if the task is
ever stopped. Docker starts with Ubuntu (section 6), and the containers come back on their own
(`restart: unless-stopped`).

### 5.1 Create the task

1. Check that the packaged WSL is installed where the task expects it:

   ```powershell
   # PowerShell (Administrator)
   Test-Path 'C:\Program Files\WSL\wsl.exe'
   ```

   It must print `True`. If not, go back to section 3.1 step 4.

2. Create the task. A window asks for your **Windows** password (the one you use for Remote
   Desktop), so it never appears in the command history:

   ```powershell
   # PowerShell (Administrator)
   $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the BarreFree WSL task'
   $action = New-ScheduledTaskAction -Execute 'C:\Program Files\WSL\wsl.exe' -Argument '-d Ubuntu-24.04 --exec /usr/bin/sleep infinity'
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
   Register-ScheduledTask -TaskName 'BarreFree WSL' -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password
   ```

3. Check the time limit. It must print `PT0S` (that `[TimeSpan]::Zero` becomes `PT0S` is
   expected but not documented):

   ```powershell
   # PowerShell (Administrator)
   (Get-ScheduledTask -TaskName 'BarreFree WSL').Settings.ExecutionTimeLimit
   ```

4. Check whether your Windows password expires:

   ```powershell
   # PowerShell (Administrator)
   net user $env:USERNAME | Select-String 'Password expires'
   ```

   If it shows a date instead of `Never`, every password change, including one Windows forces at
   sign-in, needs the update below, or the app will not come back after the next reboot. Whenever
   you change your Windows password, update the task:

   ```powershell
   # PowerShell (Administrator)
   $cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'New Windows password'
   Set-ScheduledTask -TaskName 'BarreFree WSL' -User $cred.UserName -Password $cred.GetNetworkCredential().Password
   ```

### 5.2 Test it with a real reboot

Do this now, before installing Docker, and again at the end (section 8.7).

1. Restart:

   ```powershell
   # PowerShell (Administrator)
   Restart-Computer
   ```

2. Wait 3 minutes, reconnect with Remote Desktop, and check **without starting WSL yourself**
   (these commands only look):

   ```powershell
   # PowerShell (Administrator)
   wsl --list --running
   Get-ScheduledTask -TaskName 'BarreFree WSL' | Select-Object State
   Get-ScheduledTaskInfo -TaskName 'BarreFree WSL' | Select-Object LastRunTime, LastTaskResult
   ```

   Expected: `Ubuntu-24.04` is listed; `State` is `Running`; `LastTaskResult` is `267009`
   (0x41301, "the task is currently running",
   [Task Scheduler codes](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants)).

3. Sign out of Remote Desktop (Start > your account > Sign out), wait a minute, sign in again
   and repeat step 2. `Ubuntu-24.04` must still be running.

If WSL did not start, see "Down after a reboot" in [section 11](#11-troubleshooting). Reports
from other people, for context:

- Server 2025: a Docker-in-WSL stack that did not come back after a reboot, and a task using
  `C:\Windows\System32\wsl.exe` that failed with result `4294967295`
  ([WSL discussion 14261](https://github.com/microsoft/WSL/discussions/14261)). A reply there
  suggested `autostart=true` in `.wslconfig`; no such setting exists in WSL's source.
- A June 2025 comment reports that the `Program Files` copy of WSL "Works on Server 25"
  ([WSL issue 9231](https://github.com/microsoft/WSL/issues/9231)).
- A community guide for Server 2025 delays its start-up task by 3 minutes
  ([Level1Techs](https://forum.level1techs.com/t/use-wsl-as-a-server-through-windows-server-2025/237049)).

**Rule for later: start WSL again with the task.** Whenever you stop WSL yourself
(`wsl --shutdown`, `wsl --terminate`, a backup or a disk compaction), start it again with the
task, before you open Ubuntu with `wsl ~`:

```powershell
# PowerShell (Administrator)
Start-ScheduledTask -TaskName 'BarreFree WSL'
Start-Sleep -Seconds 15
wsl --list --running
```

`Ubuntu-24.04` must be listed; if it is not, run `wsl --list --running` again after a minute. If
it is still missing and `(Get-ScheduledTask -TaskName 'BarreFree WSL').State` shows `Running`,
an old run of the task is stuck (the task ignores a new start while one is running): run
`Stop-ScheduledTask -TaskName 'BarreFree WSL'`, then the three lines above again.

This rule does not cover `wsl --update`: reboot after it (section 9.4).

---

## 6. Install Docker Engine in Ubuntu

Docker's documented method for Ubuntu 24.04 is its apt repository
([Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)). Do not use the
`get.docker.com` script: Docker does not recommend it for production, and on WSL it prints a
recommendation to use Docker Desktop and pauses 20 seconds before continuing
([script](https://get.docker.com/)).

All commands in this section run in the Ubuntu shell (open it with `wsl ~`). Start with
`sudo -v` and type your Linux password, so the blocks below can be pasted whole.

1. Remove conflicting packages (apt may say none are installed; that is fine):

   ```bash
   # Ubuntu
   sudo apt remove $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc | cut -f1)
   ```

2. Add Docker's repository:

   ```bash
   # Ubuntu
   sudo apt update
   sudo apt install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc

   sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
   Types: deb
   URIs: https://download.docker.com/linux/ubuntu
   Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
   Components: stable
   Architectures: $(dpkg --print-architecture)
   Signed-By: /etc/apt/keyrings/docker.asc
   EOF

   sudo apt update
   ```

3. Install Docker Engine and the Compose plugin:

   ```bash
   # Ubuntu
   sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   ```

4. Make sure Docker starts whenever Ubuntu starts. On Ubuntu this is already the default; the
   commands make it explicit ([post-install](https://docs.docker.com/engine/install/linux-postinstall/)):

   ```bash
   # Ubuntu
   sudo systemctl enable docker.service containerd.service
   systemctl is-enabled docker
   systemctl is-active docker
   ```

   The two checks must print `enabled` and `active`.

5. Verify:

   ```bash
   # Ubuntu
   sudo docker run hello-world
   ```

   It prints "Hello from Docker!".

6. Let your Linux user run `docker` without `sudo`
   ([post-install](https://docs.docker.com/engine/install/linux-postinstall/)):

   ```bash
   # Ubuntu
   sudo groupadd docker
   sudo usermod -aG docker $USER
   ```

   (`groupadd` may say the group already exists; that is fine.) Then leave Ubuntu with `exit`.

   **Warning:** the `docker` group grants root-level privileges on this Linux system: anyone
   in it can, for example, mount `/` into a container
   ([Docker security](https://docs.docker.com/engine/security/)). Add only yourself.

7. Open a new Ubuntu shell (PowerShell: `wsl ~`) and test without `sudo`:

   ```bash
   # Ubuntu
   docker run hello-world
   ```

   If it still says _permission denied_, restart the distribution so the group change applies
   (Docker docs: "it may be necessary to restart the virtual machine"). Leave Ubuntu with
   `exit`, then:

   ```powershell
   # PowerShell (Administrator)
   wsl --terminate Ubuntu-24.04
   Start-ScheduledTask -TaskName 'BarreFree WSL'
   Start-Sleep -Seconds 15
   wsl --list --running
   ```

   (`Ubuntu-24.04` must be listed; see the rule at the end of section 5.2.) Then open Ubuntu
   again with `wsl ~` and repeat the test.

**Logs.** Docker's default `json-file` log driver never rotates logs on its own
([logging](https://docs.docker.com/engine/logging/configure/)). BarreFree's compose file already
rotates its own containers' logs (3 files of 10 MB each), so you need to do nothing.

**Firewall.** Ports that Docker publishes bypass `ufw` and `firewalld` rules
([Docker on Ubuntu](https://docs.docker.com/engine/install/ubuntu/),
[packet filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/)), so a
Linux firewall would not protect a published port. That is why BarreFree publishes the API on
`127.0.0.1` only: such a port is reachable only from the machine itself
([port publishing](https://docs.docker.com/engine/network/port-publishing/)). In addition, WSL's
default NAT network is not reachable from outside the server unless someone adds a Windows port
proxy ([WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)). Do not change
the `ports:` line to `0.0.0.0`, and do not add a `netsh interface portproxy` rule: Cloudflare
reaches the app through `cloudflared`, inside Docker's own network.

---

## 7. Get BarreFree running

### 7.1 Keep everything inside Linux

Clone the repository into your Linux home directory, **not** under `/mnt/c`. Microsoft
recommends keeping files used from Linux in the Linux file system for performance
([WSL file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)), and Docker's
images and volumes already live there (inside the distribution's virtual disk). Cloning with
Ubuntu's `git` also keeps the Linux line endings the repository requires (`.gitattributes`).

### 7.2 Clone and configure

1. Get the code (in the Ubuntu shell). First make sure Git is installed:

   ```bash
   # Ubuntu
   sudo apt install -y git
   ```

   Then clone into your home directory:

   ```bash
   # Ubuntu
   cd ~
   git clone https://github.com/leffloard/guitartune.git ~/barrefree
   cd ~/barrefree
   ```

   The repository is public, so Git asks for nothing. (If it is ever made private, Git asks for a
   user name and a password: use a GitHub
   [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
   with read access to this repository as the password. Keep it in your password manager:
   `git pull` in section 10.1 asks again.)

2. Create your settings file. It will hold the tunnel token, so only your user may read it:

   ```bash
   # Ubuntu
   cp .env.example .env
   chmod 600 .env
   nano .env
   ```

   (In `nano`: Ctrl+O, Enter saves; Ctrl+X quits.) Edit `.env` only inside Ubuntu, never with a
   Windows editor through `\\wsl$`. Every line is optional. Review these:

   | Setting                                         | Default                | When to change it                                                                   |
   | ----------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
   | `MAX_UPLOAD_MB`                                 | `50`                   | Largest upload. Keep it well below 100 behind Cloudflare's Free plan (section 8.6). |
   | `MAX_DURATION_SEC`                              | `900`                  | Longest song (15 minutes). Shorter songs need less memory and time.                 |
   | `WORKER_MEMORY_LIMIT`, `API_MEMORY_LIMIT`       | `4g`, `1g`             | Their sum plus 1 GB must fit in `.wslconfig` `memory` (section 4.2).                |
   | `SEPARATION`, `TRANSCRIPTION`, `RECOGNIZERS`    | on, on, `chordino,btc` | Turn off what you do not want to offer; its model is then not downloaded.           |
   | `MAX_PENDING_JOBS`, `UPLOAD_RATE_PER_MIN`       | `20`, `6`              | Jobs queued or running at once, and uploads per visitor per minute.                 |
   | `ENABLE_URL_IMPORT`                             | `false`                | Leave off unless you have read section 9.3.                                         |
   | `CLOUDFLARE_TUNNEL_TOKEN`, `CLIENT_IP_HEADER`   | empty                  | Filled in section 8.3.                                                              |
   | `COMPOSE_PROFILES`, `TUNNEL_TRANSPORT_PROTOCOL` | off, `auto`            | Section 8.3; section 11 ("Tunnel connects and drops repeatedly").                   |
   | `NODE_IMAGE`, `PYTHON_IMAGE`                    | Docker Hub             | Uncomment the mirror lines if the build fails with a Docker Hub pull rate limit.    |

   The full list with explanations is in [.env.example](../.env.example) and
   [config.py](../services/analyzer/src/barrefree_analyzer/config.py).

### 7.3 Build and start

```bash
# Ubuntu
cd ~/barrefree
docker compose up -d --build
```

The first build downloads the base images, PyTorch (CPU) and the other dependencies, and
compiles the Chordino plugin, so it takes a while. It can sit on one step (PyTorch, the Chordino
compile) for many minutes. It is finished when the prompt returns without an error message. Do
not sign out or close the window while it runs. If it is interrupted, run the same command
again: finished steps are reused, and later builds reuse the cache too. If it stops with
`exit code: 137` or `Killed`, see section 11.

Check the containers:

```bash
# Ubuntu
docker compose ps
```

`api` should become `Up ... (healthy)` within a minute; `worker` shows `Up`.

### 7.4 Watch the first model download

On its first start the worker downloads about 180 MB of model weights into the `model-cache`
volume and checks each file's SHA-256:

```bash
# Ubuntu
docker compose logs -f worker
```

You will see `downloading beat_this ...`, `downloading btc ...`, `downloading htdemucs ...` and
`downloading basic_pitch ...`, then a line such as
`available: Availability(recognizers=('chordino', 'btc'), separation=True, transcription=True)`
and `worker started`. Press Ctrl+C to stop watching (the worker keeps running).

A line `could not get model ...` means that download failed. The app still works without it
(BTC, separation or tab mode is just not offered); fix the cause and run
`docker compose restart worker` to try again (section 11).

One failure does not show in `/api/health` (section 7.5): without `beat_this`, the worker
silently uses the simpler librosa beat tracker. Check that every download worked:

```bash
# Ubuntu
docker compose logs worker | grep "could not get model"
```

It must print nothing.

### 7.5 Check the health endpoint

```bash
# Ubuntu
curl -s http://127.0.0.1:8000/api/health; echo
```

Expected, once the models are in (one line):

```text
{"status":"ok","version":"0.0.0","features":{"urlImport":false,"recognizers":["chordino","btc"],"separation":true,"transcription":true,"maxUploadMb":50,"maxDurationSec":900}}
```

Until the downloads finish, `recognizers` lists only `chordino`, and `separation` and
`transcription` are `false`. That is normal, and the API needs no restart. The web app reads
these features once when a page loads, so reload any page you opened during the download.

`status` is `degraded` only if no chord recognizer is available at all (section 11).

**From Windows.** WSL forwards ports bound to `localhost` inside WSL to Windows' own `localhost`
(`localhostForwarding`, on by default,
[WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)). That this also
covers a port Docker publishes on `127.0.0.1` is expected but not documented; check it:

```powershell
# PowerShell (Administrator)
Invoke-RestMethod http://localhost:8000/api/health
```

If that works and the server has a browser, you can open `http://localhost:8000` in it. If it
does not, nothing is wrong with the app: test from your own computer after section 8.

### 7.6 First test, and measure your server

1. Open the app (on the server at `http://localhost:8000`, or after section 8 at your own
   hostname), upload a short recording you have the right to use (for example a phone recording
   of yourself playing a few chords) and wait for the chord chart. Follow it in the worker log:

   ```bash
   # Ubuntu
   docker compose logs -f worker
   ```

   A finished job logs `job <id> done in <n> s`.

2. Measure this server (takes several minutes and uses every core: run it when nobody is
   using the app):

   ```bash
   # Ubuntu
   docker compose run --rm --no-deps worker barrefree-benchmark --minutes 3,15
   ```

   This runs in a separate container with its own memory limit (the worker's), so it cannot push
   the worker over its limit; it still shares the server's CPUs and RAM, so a job running at the
   same time skews the timings. The 15-minute part takes about half an hour; leave out
   `,15` for a quick check. Compare the "Decode" and "Analysis" rows with
   [docs/benchmarks.md](benchmarks.md). If peak memory is close
   to `WORKER_MEMORY_LIMIT`, raise the limit and `.wslconfig` `memory`, or lower
   `MAX_DURATION_SEC`.

---

## 8. Publish with Cloudflare Tunnel

### 8.1 Prerequisites

- A Cloudflare account and a domain added to it as a website (zone). Publishing an application
  through a tunnel requires that the domain is on Cloudflare; on the Free plan the domain must
  use Cloudflare's nameservers (full setup), because the CNAME (partial) setup is only for
  Business and Enterprise plans
  ([Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/),
  [partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/)).
  Tunnels are available on all plans. (Section 2.4: start this early.)
- A hostname to use, for example `chords.<your-domain>`.
- You do not need a certificate, a reverse proxy or a change to the zone's SSL/TLS mode: the mode
  does not affect a tunnel route to an HTTP service
  ([HTTPS origins](https://developers.cloudflare.com/tunnel/troubleshooting/https-origins/)).

### 8.2 Create the tunnel and copy its token

Cloudflare's dashboard changes often; these steps follow its documentation as of October 2026
([create a tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/),
[get started](https://developers.cloudflare.com/tunnel/get-started/)).

1. In the Cloudflare dashboard go to **Networking > Tunnels**. (The same tunnels are also under
   **Zero Trust > Networks > Connectors**,
   [changelog](https://developers.cloudflare.com/changelog/post/2026-02-20-tunnel-core-dashboard/).)
2. Select **Create a tunnel** (or **Create Tunnel**), give it a name such as `barrefree`, and
   create it.
3. When asked for the environment, choose **Docker**
   ([Cloudflare guide](https://developers.cloudflare.com/tunnel/guides/kubernetes/); the exact
   label in the wizard may differ). The page shows a `docker run ... --token eyJ...` command.
   **Do not run it.** You need only the token: the long string after `--token `, which starts
   with `eyJ` ([tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)).
   Copy the whole command with the dashboard's copy button, paste it into Notepad, and copy only
   the part after `--token `. Keep the dashboard page open.

Anyone who has the token can run your tunnel. Treat it like a password (section 9.2).

### 8.3 Put the token in `.env` and start `cloudflared`

1. Write the token and two more settings into `.env` (in the Ubuntu shell). The `read` line asks
   for the token: paste it there (nothing appears on screen) and press Enter. The other lines
   remove the `#` in front of `CLIENT_IP_HEADER` and `COMPOSE_PROFILES` in your `.env`, so
   nothing is added twice:

   ```bash
   # Ubuntu
   cd ~/barrefree
   read -rsp 'Paste the tunnel token (nothing appears), then press Enter: ' T; echo
   sed -i "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$T|; s|^# *CLIENT_IP_HEADER=CF-Connecting-IP|CLIENT_IP_HEADER=CF-Connecting-IP|; s|^# *COMPOSE_PROFILES=tunnel|COMPOSE_PROFILES=tunnel|" .env
   unset T
   grep -q '^CLIENT_IP_HEADER=' .env || echo 'CLIENT_IP_HEADER=CF-Connecting-IP' >> .env
   grep -q '^COMPOSE_PROFILES=' .env || echo 'COMPOSE_PROFILES=tunnel' >> .env
   grep -cE '^(CLOUDFLARE_TUNNEL_TOKEN=eyJ|CLIENT_IP_HEADER=CF-Connecting-IP|COMPOSE_PROFILES=tunnel)' .env
   ```

   The last command must print `3`. If it prints less, run the block again and paste the token
   carefully. The three settings now in `.env`:
   - `CLOUDFLARE_TUNNEL_TOKEN`: the token; only the `cloudflared` container receives it.
   - `CLIENT_IP_HEADER=CF-Connecting-IP`: behind the tunnel every request reaches the API from
     the `cloudflared` container, so the per-visitor upload limit must read the visitor's
     address from the header Cloudflare adds
     ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)).
     This is safe only because nothing else can reach the API (section 9.1).
   - `COMPOSE_PROFILES=tunnel`: enables the `tunnel` profile for every `docker compose` command
     run in this folder, the same as typing `--profile tunnel` each time
     ([profiles](https://docs.docker.com/compose/how-tos/profiles/),
     [Compose variables, set in `.env`](https://docs.docker.com/compose/how-tos/environment-variables/envvars/)).
     Without it, later commands would ignore the `cloudflared` service.

2. Start everything, including `cloudflared`:

   ```bash
   # Ubuntu
   docker compose up -d
   docker compose ps
   ```

   `docker compose ps` must now list `cloudflared` too (that shows `COMPOSE_PROFILES` works).
   After about a minute it should show `(healthy)`. Its health check asks cloudflared's `/ready`
   endpoint, which answers OK only while at least one connection to Cloudflare is up
   ([observability](https://developers.cloudflare.com/tunnel/observability/)). If it does not
   become healthy: `docker compose logs cloudflared`, and section 8.8.

   Check that the API got the client IP setting:

   ```bash
   # Ubuntu
   docker compose exec api printenv CLIENT_IP_HEADER
   ```

   It must print `CF-Connecting-IP`. Without it, all visitors share one allowance of 6 uploads
   per minute (section 11, `429`).

   The dashboard now shows the connector as connected; select **Continue** in the wizard. If you
   want Cloudflare Access (8.4) and the wizard asks for a route right after **Continue**, stop
   there: the tunnel already exists. Do 8.4, then add the route from the tunnel's **Routes** tab
   (8.5).

### 8.4 Recommended: allow only people you choose (Cloudflare Access)

Recommended: the app has no accounts, so without Access anyone who finds the address can queue
CPU-heavy analyses on your server. The only brakes are the upload limits: 6 uploads per visitor
per minute and at most 20 jobs queued or running. Leave Access off only if you want the app to
be public. Cloudflare recommends creating the Access application **before** the route, because
without one the published app is public
([self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)).

**Check on your server:** the first time you open **Zero Trust**, the dashboard may ask for a
team name and a plan. The research behind this guide does not cover that screen; choose the Free
plan (step 4).

1. In **Zero Trust > Access controls > Applications**, select **Create new application >
   Self-hosted and private**, then **Add public hostname** and enter the hostname you will use
   (for example `chords` + your domain).
2. Add an **Allow** policy, for example an _Include_ rule with the email addresses of the people
   you want to let in. Access denies everyone else by default.
3. Login method: new Zero Trust organizations get the Cloudflare identity provider by default,
   which only admits members of your Cloudflare account
   ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-18-cloudflare-idp-default/)).
   To let friends in by email code, add **One-time PIN** under
   **Zero Trust > Integrations > Identity providers > Add new identity provider**
   ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)),
   and always pair it with specific email addresses in the Include rule
   ([common policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)).
4. The Zero Trust Free plan is for up to 50 users
   ([Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/)).

### 8.5 Route your hostname to the app

1. Open the tunnel, go to the **Routes** tab, select **Add route > Published application**
   ([get started](https://developers.cloudflare.com/tunnel/get-started/)). If you skipped Access
   and the wizard asks for a route right after **Continue**, fill in the same values there.
2. Fill in:
   - **Hostname**: a subdomain (e.g. `chords`) and your domain from the drop-down. Leave the path
     empty.
   - **Service URL**: `http://api:8000`

   Not `http://localhost:8000` (the dashboard's example): inside `cloudflared`'s container,
   `localhost` is `cloudflared` itself. In the compose network every service is reachable by its
   service name on its container port
   ([Compose networking](https://docs.docker.com/compose/how-tos/networking/)). This stays
   `api:8000` even if you changed `BARREFREE_PORT`. (Older dashboard screens call this a
   _Public hostname_ with service type `HTTP` and URL `api:8000`.)

3. Select **Add route**. Cloudflare creates the DNS record for the hostname automatically, a
   CNAME to `<tunnel id>.cfargotunnel.com`
   ([routing](https://developers.cloudflare.com/tunnel/concepts/routing/)). In your domain's DNS
   tab, check that the record exists and shows as **Proxied** (the dashboard default is not
   documented).

### 8.6 Check, and the limits that matter

1. From your own computer or phone, open `https://<your hostname>/api/health`, then
   `https://<your hostname>/`. With Access on, you log in first.
2. Upload a test song and watch its progress page.

Limits to know:

- **Upload size.** Cloudflare accepts request bodies up to 100 MB on Free and Pro, 200 MB on
  Business; larger uploads get a `413` from Cloudflare
  ([default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)).
  The app's own limit is 50 MB (`MAX_UPLOAD_MB`), so it applies first. If you raise it, stay well
  below 100 on Free: the form adds a little overhead.
- **Long requests.** Cloudflare gives up on an origin that sends nothing for 125 seconds (error
  `524`, Proxy Read Timeout; only Enterprise can change it,
  [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)).
  Cloudflare defines this as the time _between two reads_
  ([cache rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)),
  and the progress page uses a Server-Sent Events stream that sends an update on every change
  and a keep-alive at least every 15 seconds, so a long analysis should not hit it. But one
  Cloudflare page says streaming beyond 125 seconds needs a longer timeout
  ([HTTP/2 to origin](https://developers.cloudflare.com/speed/optimization/protocol/http2-to-origin/)),
  and the docs do not say how the timer applies to tunnels. If a stream is ever cut, the browser
  reconnects and the page gets the job's current state. **Check on your server:** run one job
  with separation on a song longer than 5 minutes and watch the progress page reach the end.
- **Streaming through the tunnel.** `cloudflared` streams `text/event-stream` responses as they
  arrive instead of buffering them
  ([Tunnel troubleshooting](https://developers.cloudflare.com/tunnel/troubleshooting/)).
- **Large media.** Traffic through a published tunnel route falls under the Free/Pro/Business
  CDN terms, which disallow serving video or a disproportionate amount of large files without a
  paid service
  ([Cloudflare policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)).
  The app sends each song's playback MP3 once to the browser that analysed it; for a personal
  or small-group server this is a judgement call, not a stated threshold.
- **Caching.** Cloudflare does not cache the API's responses or the playback audio (they are
  not cacheable file types or are marked `private`/`no-cache`,
  [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)),
  and the app marks `index.html` `no-cache`, so an update shows up right away.

### 8.7 Final reboot test

Repeat section 5.2, and this time also check from your phone (mobile data, not the server) that
`https://<your hostname>/api/health` answers **before** you log in to the server after the
restart. That proves the whole chain comes back on its own. With Access on, the phone first
shows Cloudflare's login page; the login happens at Cloudflare, not on your server, and after it
the health JSON must appear.

Optional but useful: Cloudflare's notifications include a **Tunnel Health Alert**, available on
all Zero Trust plans ([observability](https://developers.cloudflare.com/tunnel/observability/)).
Add one for this tunnel, and you get an email when it goes down, for example after a reboot that
did not bring WSL back.

### 8.8 Outbound network requirements

`cloudflared` needs only outbound access
([Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/)):

| Destination                                                                                                                                                               | Port                                  | Needed                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region1.v2.argotunnel.com`, `region2.v2.argotunnel.com` (the 198.41.192.x and 198.41.200.x addresses, and IPv6 in 2606:4700:a0:: and 2606:4700:a8::, listed on the page) | 7844 UDP (QUIC) and 7844 TCP (HTTP/2) | Yes. QUIC is tried first; HTTP/2 over TCP is the fallback ([run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)). |
| Your DNS resolver                                                                                                                                                         | 53 UDP                                | Yes: cloudflared finds Cloudflare's servers through SRV records.                                                                                  |
| `api.cloudflare.com`, `update.argotunnel.com`, `<team>.cloudflareaccess.com` and others                                                                                   | 443 TCP                               | Optional (update checks, Access token checks).                                                                                                    |

Firewalls that check the server name (SNI) must also allow `cftunnel.com`, `h2.cftunnel.com` and
`quic.cftunnel.com` on 7844 ([Tunnel configuration](https://developers.cloudflare.com/tunnel/configuration/)).

The worker also needs outbound HTTPS once, to download its models (`cloud.cp.jku.at`,
`raw.githubusercontent.com`, `huggingface.co` and the `*.hf.co` download host it redirects to,
which depends on the region). Installing Docker needs `download.docker.com` and Ubuntu's package
archive. The image build needs Docker Hub, `ghcr.io` (the `uv` image), `github.com` (the
Chordino sources), Debian's package mirrors (`deb.debian.org`), PyPI, the PyTorch download
server (`download.pytorch.org`) and the npm registry.

If your provider's firewall (or a Windows firewall policy) restricts outbound traffic, allow
these. To test from Ubuntu
([connectivity pre-checks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/)),
install the tools first:

```bash
# Ubuntu
sudo apt install -y dnsutils netcat-openbsd
```

Then:

```bash
# Ubuntu
dig A region1.v2.argotunnel.com
dig SRV _v2-origintunneld._tcp.argotunnel.com
nc -vz -w 3 198.41.192.167 7844
nc -uvz -w 3 198.41.192.167 7844
```

If either the TCP or the UDP test succeeds, the tunnel can connect (a UDP "succeeded" only means
nothing rejected it). Recent `cloudflared` versions also run these checks at start and log the
result (`docker compose logs cloudflared`).

---

## 9. Security notes

### 9.1 No inbound ports

The app is reachable only through Cloudflare. The API is published on `127.0.0.1` inside WSL
(section 6), WSL's NAT network is not reachable from outside, and `cloudflared` connects
outwards. This is also what makes `CLIENT_IP_HEADER=CF-Connecting-IP` safe: a client that could
reach the API directly could forge that header
([restoring visitor IPs](https://developers.cloudflare.com/support/troubleshooting/restoring-visitor-ips/restoring-original-visitor-ips/)).

The one port that stays open is the provider's Remote Desktop port. If your provider's control
panel has a firewall, allow Remote Desktop only from your own IP address.

### 9.2 Keep the tunnel token secret

- The token is in `.env`, which Git ignores (`.gitignore`) and which only your Linux user can
  read (`chmod 600`). Never commit it, paste it in a chat or put it in `docker-compose.yml`.
- Compose does not hand `.env` to the containers: the analysis containers get only the
  settings listed in `docker-compose.yml` (`x-env`), and only `cloudflared` gets the token. So
  a bug in the code that handles uploads cannot leak it. (Anyone in the `docker` group can still
  read it with `docker inspect`; that group is root-equivalent anyway.)
- If the token leaks: in the dashboard open the tunnel and **Rotate token**, put the new token in
  `.env` (the block in section 8.3 step 1 replaces it), and run `docker compose up -d`. The old
  token can no longer open new connections, but connectors already running with it stay up until
  they restart; for a compromised token Cloudflare also documents how to force-disconnect them
  through its API
  ([tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)).
- Do not run `cloudflared` with `--loglevel debug` in production: it logs every request's
  headers, cookies included
  ([run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)).

### 9.3 YouTube/Spotify link import stays off

Link import is **off by default** (`ENABLE_URL_IMPORT=false`). Downloading from YouTube may
violate its terms of service: whoever runs the server decides whether to enable it, and using it
is that person's responsibility, for songs they have the right to use (see the
[README](../README.md#legal)). YouTube often refuses data-center servers. The optional cookies
file that works around this gives anyone who obtains it access to that Google account, and
YouTube may flag or block an account used this way. Read
[architecture.md §4c](architecture.md#4c-link-import-m6-off-by-default) before you enable either.

If you do enable link import and YouTube refuses the server, this is how a cookies file (Netscape
`cookies.txt` format, of a separate Google account made for this) gets into the data volume,
readable only by the app. Copy the file to the server first, for example into your Windows
Downloads folder; `<windows-user>` is your Windows user name (PowerShell: `$env:USERNAME`):

```bash
# Ubuntu
cd ~/barrefree
docker compose cp /mnt/c/Users/<windows-user>/Downloads/youtube-cookies.txt worker:/data/youtube-cookies.txt
docker compose exec -u root worker sh -c 'chown barrefree /data/youtube-cookies.txt && chmod 600 /data/youtube-cookies.txt'
rm /mnt/c/Users/<windows-user>/Downloads/youtube-cookies.txt
```

Then set `ENABLE_URL_IMPORT=true` and `URL_IMPORT_COOKIES=/data/youtube-cookies.txt` in `.env`
and run `docker compose up -d`.

### 9.4 Keep Windows, WSL, Ubuntu and Docker up to date

- **Windows:** install Windows Updates as usual. The boot task (section 5) brings everything back
  after the restarts they need; check the site after each patch day.
- **WSL:** on a server without the Store, update WSL yourself. Microsoft says the web-download
  route needs a manual update for every release
  ([compare WSL versions](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)).
  Monthly, when no analysis is running (`docker compose logs --tail 20 worker`):

  ```powershell
  # PowerShell (Administrator)
  wsl --update
  Restart-Computer
  ```

  After the restart, check as in section 5.2 (and `wsl --version` must show the new version).
  Restarting lets the boot task start WSL before anyone signs in. Installing the update most
  likely restarts the WSL service (an inference, not documented), which ends WSL's session
  ([WSL source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/ServiceMain.cpp)).
  The next `wsl` command then starts a new one, and if that command ran in your Remote Desktop
  session, WSL belongs to that session and stops when you sign out (section 5). A plain
  `Start-ScheduledTask` after an update is therefore not enough. Do not use `--pre-release` on a
  server.

- **Ubuntu and Docker:** Docker was installed from its apt repository, so apt updates it with
  the rest ([upgrade Docker Engine](https://docs.docker.com/engine/install/ubuntu/)). Monthly:

  ```bash
  # Ubuntu
  sudo apt update && sudo apt upgrade -y
  ```

  An upgrade of Docker restarts the containers; an analysis running at that moment may be
  interrupted, and the visitor can retry.

- **cloudflared** is pinned to a version in `docker-compose.yml` and updated with BarreFree
  (section 10.1). Cloudflare supports versions released within one year of its latest release
  ([downloads](https://developers.cloudflare.com/tunnel/downloads/)), so update BarreFree at
  least a few times a year.

---

## 10. Operations

All `docker compose` commands run in `~/barrefree` in the Ubuntu shell (`cd ~/barrefree`).
Because `.env` sets `COMPOSE_PROFILES=tunnel`, they include `cloudflared`.

### 10.1 Update BarreFree

Update when no analysis is running:

```bash
# Ubuntu
cd ~/barrefree
git pull
docker compose up -d --build
docker compose ps
```

Compose rebuilds the image and recreates only containers whose image or settings changed;
volumes are kept ([compose up](https://docs.docker.com/reference/cli/docker/compose/up/)). A job
that is running during the update gets up to 2 minutes to finish (`WORKER_STOP_GRACE`);
otherwise it is marked interrupted. If the update changes `cloudflared`, open progress pages
lose their connection for a moment and reconnect
([updating cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/update-cloudflared/)).
After a pull, check whether `.env.example` gained new settings:

```bash
# Ubuntu
git diff ORIG_HEAD HEAD -- .env.example
```

The image build has no memory limit, it runs while the app keeps running, and its peak memory
was not measured. If the build stops with `exit code: 137` or `Killed`, stop the worker while
building:

```bash
# Ubuntu
docker compose stop worker && docker compose build && docker compose up -d
```

### 10.2 Logs and status

```bash
# Ubuntu
docker compose ps
docker compose logs --tail 100 api
docker compose logs -f worker
docker compose logs --tail 50 cloudflared
docker stats --no-stream
```

### 10.3 Backups

What there is to back up:

- **Songs are not on the server.** Each visitor's songs live in their own browser; the server
  deletes jobs, audio and results after 6 hours (`TEMP_FILE_TTL_SEC`), usually within seconds of
  saving.
- **`.env`** (your settings and the tunnel token): keep a copy somewhere safe, such as a password
  manager. Even the token can be fetched again from the dashboard: open the tunnel, **Add a
  replica**, and copy the command without running it
  ([tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)).
- **Volumes:** `barrefree_jobs-data` (`/data`: the job queue and temporary files) and
  `barrefree_model-cache` (`/models`: about 180 MB of weights, which can always be downloaded
  again). Compose names them after the project name `barrefree`
  ([Compose volumes](https://docs.docker.com/reference/compose-file/volumes/)); check with
  `docker volume ls`.

Backing up the volumes is optional: `jobs-data` holds only the queue and files deleted within 6
hours, and `model-cache` downloads again on its own. If you still want a copy, stop `api` and
`worker` first so the SQLite queue is not written during the copy (this follows Docker's
documented pattern,
[back up a volume](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)):

```bash
# Ubuntu
cd ~/barrefree
mkdir -p "$HOME/backups"
docker compose stop api worker
docker run --rm -v barrefree_jobs-data:/data:ro -v "$HOME/backups":/backup ubuntu tar czf /backup/jobs-data-$(date +%F).tgz -C /data .
docker run --rm -v barrefree_model-cache:/models:ro -v "$HOME/backups":/backup ubuntu tar czf /backup/model-cache-$(date +%F).tgz -C /models .
docker compose up -d
ls -lh "$HOME/backups"
```

Restore one (replace the date):

```bash
# Ubuntu
cd ~/barrefree
docker compose stop api worker
docker run --rm -v barrefree_jobs-data:/data -v "$HOME/backups":/backup ubuntu tar xzf /backup/jobs-data-<YYYY-MM-DD>.tgz -C /data
docker compose up -d
```

To copy backups off the Linux disk, use Windows Explorer at
`\\wsl$\Ubuntu-24.04\home\<linux-user>\backups`. WSL's source expects the file share to work for
a WSL started by a scheduled task once you run a `wsl` command in your own session
([WSL source](https://github.com/microsoft/WSL/blob/3.0.3/src/windows/service/exe/LxssUserSession.cpp)),
but this was not tested. If Explorer cannot open the path, copy from Ubuntu instead:

```bash
# Ubuntu
cp ~/backups/*.tgz /mnt/c/Users/<windows-user>/Documents/
```

Copying finished backups to `/mnt/c` is fine; only the clone and Docker's data must stay in the
Linux file system. Do not touch the WSL files under `AppData` with Windows tools; Microsoft warns
this can corrupt the distribution
([WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space)).

### 10.4 Disk space

The distribution lives in a virtual disk (`ext4.vhdx`) that **grows automatically and does not
shrink** when files are deleted
([WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space),
[compact vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)).
Each rebuild leaves old images and build cache behind; Docker never removes them on its own
([pruning](https://docs.docker.com/engine/manage-resources/pruning/)).

1. See what uses space:

   ```bash
   # Ubuntu
   docker system df
   ```

   ```powershell
   # PowerShell (Administrator)
   wsl.exe --system -d Ubuntu-24.04 df -h /mnt/wslg/distro
   ```

2. Free space inside Linux (named volumes are never touched by these; answer `y`):

   ```bash
   # Ubuntu
   docker image prune
   docker buildx prune
   ```

3. Give the freed space back to Windows. WSL 3.0 and later have a compaction command; it stops
   the distribution, so run it when nobody uses the app. It is new and not yet on Microsoft's
   documentation pages, so check that `wsl --help` lists `--compact` first:

   ```powershell
   # PowerShell (Administrator)
   wsl --help
   wsl --manage Ubuntu-24.04 --compact
   ```

   Then start WSL again with the task (the rule at the end of section 5.2).

   On an older WSL, use Windows' `diskpart` on the stopped disk
   ([compact vdisk](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk)).
   How much it reclaims from a Linux (ext4) disk is not documented. Find the disk's path
   ([WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space)), stop WSL, and
   compact:

   ```powershell
   # PowerShell (Administrator)
   (Get-ChildItem -Path HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss | Where-Object { $_.GetValue("DistributionName") -eq 'Ubuntu-24.04' }).GetValue("BasePath") + "\ext4.vhdx"
   wsl --shutdown
   diskpart
   ```

   In the `diskpart` window, type these lines one by one (use the path printed above), then start
   WSL again with the task (the rule at the end of section 5.2):

   ```text
   select vdisk file="<path>\ext4.vhdx"
   compact vdisk
   exit
   ```

Avoid the experimental "sparse" disk option on a server.

### 10.5 Full backup of the whole Linux system

`wsl --export` saves the entire distribution (Ubuntu, Docker, images, volumes, your clone and
`.env`) to one file, and `wsl --import` restores it, also on a new server
([WSL FAQ](https://learn.microsoft.com/en-us/windows/wsl/faq),
[basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)). The export
**stops the distribution** and with it the app.

The file contains `.env` with the tunnel token: keep it private. It also contains every Docker
image and the build cache, it is written to C:, and it can be as large as the Linux disk's used
space. Before exporting, free the build cache (Ubuntu: `docker buildx prune`, answer `y`), then
check the free space on C: (PowerShell: `Get-PSDrive C`): keep at least the Linux disk's used
size free (section 10.4 step 1 shows it).

```powershell
# PowerShell (Administrator)
New-Item -ItemType Directory -Force C:\Backups | Out-Null
wsl --export Ubuntu-24.04 "C:\Backups\ubuntu-$(Get-Date -Format yyyy-MM-dd).tar"
```

Then start WSL again with the task (the rule at the end of section 5.2). WSL can also write a
smaller `tar.gz` (`--format tar.gz`), but its help text documents `--import` only for tar files,
so this guide keeps the plain format.

Better: put the file on a second disk or copy it off the server. To restore on a fresh server
(after section 3.1, then section 4.2 and section 5):

```powershell
# PowerShell (Administrator)
wsl --import Ubuntu-24.04 C:\WSL\Ubuntu-24.04 C:\Backups\ubuntu-<YYYY-MM-DD>.tar
```

A restored copy starts BarreFree, `cloudflared` included, as soon as Ubuntu starts, and anyone
holding the token can run the tunnel
([tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)): never run
the restored copy and the original at the same time.

### 10.6 Restarting and stopping

| You want to                        | Command                                                                                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restart the app                    | Ubuntu: `docker compose restart`                                                                                                                                                                                                                     |
| Stop the app                       | Ubuntu: `docker compose stop`. It **stays stopped**, even after a reboot, until `docker compose up -d`: that is how `restart: unless-stopped` works ([restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)). |
| Start the app again                | Ubuntu: `docker compose up -d`                                                                                                                                                                                                                       |
| Restart WSL (after config changes) | PowerShell: `wsl --shutdown`, wait until `wsl --list --running` is empty, then start WSL with the task (the rule at the end of section 5.2).                                                                                                         |
| Update WSL                         | PowerShell: `wsl --update`, then `Restart-Computer` (section 9.4).                                                                                                                                                                                   |
| Restart Windows                    | First check that no analysis is running (Ubuntu: `docker compose logs --tail 20 worker`), then PowerShell: `Restart-Computer`. Do not `docker compose stop` before a reboot, or the app stays down afterwards.                                       |

A job cut off by a restart is marked "The analysis was interrupted. Please try again." when the
worker starts again; the visitor can upload again.

### 10.7 What `WORKER_ID` and the memory limits do

- **`WORKER_ID`** (`worker-1` in `docker-compose.yml`) names the worker in the job queue. When
  the worker claims a job it records its id, so after a crash or restart it fails its unfinished
  job at once instead of leaving it "running" until the one-hour no-progress timeout.
- **More than one worker.** `docker compose up -d --scale worker=2` runs two workers, and so
  two analyses at a time. Ids are exclusive (a lock file on the data volume): the second worker
  runs as `worker-1-2`, so neither fails the other's jobs. Each worker needs its own share of
  memory (another `WORKER_MEMORY_LIMIT` in `.wslconfig`) and they share the CPU, so on a
  4-core server one worker is the better choice.
- **Memory limits** (`WORKER_MEMORY_LIMIT=4g`, `API_MEMORY_LIMIT=1g`) cap each container. A job
  that needs more is killed and the container restarts, instead of the whole WSL machine running
  out of memory and freezing. The worker does not swap: `docker-compose.yml` sets its
  `memswap_limit` to the same value as `WORKER_MEMORY_LIMIT`, so a job that needs more than the
  limit is stopped at once instead of crawling. (A container with a memory limit and no
  `memswap_limit`, such as the API, may also use as much swap as its limit,
  [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).) Keep
  `.wslconfig` `memory` at least 1 GB above the sum of the limits.
- **`WORKER_STOP_GRACE`** (2 minutes) is how long `docker compose stop` or an update lets the
  current job finish before the worker is stopped.

---

## 11. Troubleshooting

"PowerShell:" and "Ubuntu:" say where to run each command. Ubuntu commands with `docker compose`
run in `~/barrefree`.

| Symptom                                                                                                                                              | Likely cause                                                                                                                                                                                                                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wsl --status` says _"WSL2 is unable to start since virtualization is not enabled"_; install fails with `0x80370102` or `HCS_E_HYPERV_NOT_INSTALLED` | The VPS has no nested virtualization, or Windows' hypervisor is switched off                                                                                                                                                                                                         | Ask the provider (section 2.3). PowerShell: `bcdedit /enum \| findstr -i hypervisorlaunchtype`; if it says `Off`, run `bcdedit /set hypervisorlaunchtype Auto` and restart. On Azure, the VM needs Security type Standard ([WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `wsl --version`: _invalid command line option_                                                                                                       | The old built-in WSL                                                                                                                                                                                                                                                                 | Section 3.1 step 4 (`wsl --update`, or the MSI).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `wsl --install Ubuntu-24.04` hangs at 0.0 %                                                                                                          | Download problem                                                                                                                                                                                                                                                                     | Install from the image file (section 3.2 step 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ps -p 1 -o comm=` prints `init`, not `systemd`; `docker` commands fail with _Cannot connect to the Docker daemon_                                   | systemd is off                                                                                                                                                                                                                                                                       | Ubuntu: check `/etc/wsl.conf` (section 4.1). PowerShell: check `wsl --version` (systemd needs a current WSL), then `wsl --shutdown` and wait for the 8-second rule before starting again (section 4.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Ubuntu has no network (`apt update` fails)                                                                                                           | Server hardening disabled the _Internet Connection Sharing_ service, which WSL needs ([WSL troubleshooting](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting)); or `networkingMode=mirrored` on Server 2025                                                             | PowerShell: `Get-Service SharedAccess` must not be Disabled. Remove any `networkingMode` line from `.wslconfig`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `no configuration file provided: not found`                                                                                                          | You are not in the project folder                                                                                                                                                                                                                                                    | Ubuntu: `cd ~/barrefree`, then the command again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| _permission denied while trying to connect to the Docker daemon socket_                                                                              | Your user is not in the `docker` group yet                                                                                                                                                                                                                                           | Section 6 steps 6 and 7; meanwhile use `sudo docker ...`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Docker does not start, or containers have no network, with `iptables` errors in `journalctl -u docker`                                               | Firewall backend problem on the WSL kernel (a 2026 community guide reports none with current versions)                                                                                                                                                                               | A 2022 community guide switched Ubuntu to `iptables-legacy` ([dev.to](https://dev.to/jgngo/install-docker-community-in-wsl-2-ubuntu-2204-2o80)). Ubuntu: `sudo update-alternatives --config iptables`, choose legacy, `sudo systemctl restart docker`. Use only if you see such errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Image build fails with _toomanyrequests_ / pull rate limit                                                                                           | Docker Hub limits anonymous pulls                                                                                                                                                                                                                                                    | Uncomment `NODE_IMAGE` and `PYTHON_IMAGE` in `.env` (mirror) and build again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Image build fails with `no space left on device`                                                                                                     | The Linux disk or C: is full                                                                                                                                                                                                                                                         | Section 10.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Image build stops with `exit code: 137` or `Killed`                                                                                                  | Out of memory during the build                                                                                                                                                                                                                                                       | Ubuntu: `docker compose stop worker && docker compose build && docker compose up -d` (section 10.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/api/health` lacks `btc`, or `separation`/`transcription` are `false`                                                                               | A model download failed (or is still running, section 7.5)                                                                                                                                                                                                                           | Ubuntu: `docker compose logs worker \| grep "could not get model"`; check outbound HTTPS to the hosts in section 8.8; then `docker compose restart worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/api/health` says `"status": "degraded"`; uploads get `503`                                                                                         | No chord recognizer at all: `RECOGNIZERS=btc` and the BTC download failed, or the Chordino plugin is missing from the image                                                                                                                                                          | Ubuntu: remove the `RECOGNIZERS` line from `.env` (default `chordino,btc`) and `docker compose up -d`. If it stays degraded, rebuild: `docker compose build --no-cache`, then `docker compose up -d`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Worker restarts during long songs; jobs end "interrupted"                                                                                            | The worker hit its memory limit (OOM)                                                                                                                                                                                                                                                | Ubuntu: `docker inspect -f '{{.RestartCount}}' barrefree-worker-1` grows with each crash, and `sudo dmesg \| grep -i 'memory cgroup out of memory'` shows the kill at the container limit. Raise `WORKER_MEMORY_LIMIT` and `.wslconfig` `memory`, or lower `MAX_DURATION_SEC`; separation on long songs is the peak. If the whole WSL machine ran out instead, `dmesg` shows `Out of memory: Killed process` without the `Memory cgroup` prefix: `memory` in `.wslconfig` is too small.                                                                                                                                                                                                                                                                                                                                        |
| Job stays "queued"                                                                                                                                   | Worker down or busy with another job (one job at a time)                                                                                                                                                                                                                             | Ubuntu: `docker compose ps`, `docker compose logs --tail 50 worker`, `docker compose restart worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Job stays "running" without progress                                                                                                                 | The worker was killed or stuck                                                                                                                                                                                                                                                       | A restart fails the job at once (`WORKER_ID`); otherwise it is failed after one hour without progress. Ubuntu: `docker compose restart worker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Upload: _server is busy_ (`503`)                                                                                                                     | 20 jobs already queued or running (`MAX_PENDING_JOBS`)                                                                                                                                                                                                                               | Wait, or raise the limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Every visitor gets _too many uploads_ (`429`) together                                                                                               | `CLIENT_IP_HEADER` is not set behind the tunnel, so all visitors look like one                                                                                                                                                                                                       | Set `CLIENT_IP_HEADER=CF-Connecting-IP` (section 8.3), then Ubuntu: `docker compose up -d`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `413` on upload                                                                                                                                      | The file is larger than `MAX_UPLOAD_MB` or the song longer than `MAX_DURATION_SEC` (app messages), or the file is larger than 100 MB (Cloudflare Free/Pro)                                                                                                                           | Use a smaller file (e.g. MP3 instead of WAV) or raise `MAX_UPLOAD_MB` within Cloudflare's limit, or raise `MAX_DURATION_SEC`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cloudflare error **1033**                                                                                                                            | The tunnel is not connected: WSL or Docker is down, `cloudflared` is not running, the token is wrong, or outbound port 7844 is blocked ([common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)) | PowerShell: `wsl --list --running`. Ubuntu: `docker compose ps`; `docker compose logs cloudflared`; section 8.8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cloudflare error **1016**                                                                                                                            | The DNS record exists but its tunnel stopped or was deleted ([DNS records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/))                                                                                           | Start `cloudflared`, or recreate the route for the tunnel you use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **502** _Unable to reach the origin service_; the tunnel shows Healthy                                                                               | `cloudflared` cannot reach the app: the Service URL is wrong or `api` is down ([common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/))                                                          | Service URL must be `http://api:8000`; Ubuntu: `docker compose ps` must show `api` healthy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **524**                                                                                                                                              | A request sent nothing for 125 s ([error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/))                                                                                                                         | Should not happen with this app; if it does on the progress page, report it with the job length.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tunnel connects and drops repeatedly                                                                                                                 | UDP (QUIC) is unreliable on the path; network devices may time out UDP ([common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/))                                                                 | Force HTTP/2 over TCP. Ubuntu: in `.env` remove the `#` before `TUNNEL_TRANSPORT_PROTOCOL=http2` (`nano .env`), then `docker compose up -d` ([run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/)). No change to `docker-compose.yml` is needed, so `git pull` keeps working.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Down after a reboot (1033)                                                                                                                           | The boot task did not start WSL                                                                                                                                                                                                                                                      | PowerShell: `Get-ScheduledTaskInfo -TaskName 'BarreFree WSL'`. Check the task account and password (section 5.1 step 4) and that it uses `C:\Program Files\WSL\wsl.exe`. If it fails only at boot, add a start delay. PowerShell: `$cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password'; $t = New-ScheduledTaskTrigger -AtStartup; $t.Delay = 'PT2M'; Set-ScheduledTask -TaskName 'BarreFree WSL' -Trigger $t -User $cred.UserName -Password $cred.GetNetworkCredential().Password`, then check `(Get-ScheduledTask -TaskName 'BarreFree WSL').Triggers.Delay` (the delay exists in Task Scheduler, [BootTrigger.Delay](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger-delay), but setting it this way is not documented for the cmdlet). Reboot and test again. |
| The task shows `Running`, but `wsl --list --running` is empty                                                                                        | A stuck run of the task; the task ignores new starts while one runs                                                                                                                                                                                                                  | PowerShell: `Stop-ScheduledTask -TaskName 'BarreFree WSL'`, then start it again (the rule at the end of section 5.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| WSL stops when you sign out of Remote Desktop                                                                                                        | WSL was started from your Remote Desktop session, not by the boot task (for example after `wsl --update`)                                                                                                                                                                            | PowerShell: `Restart-Computer`, so the task starts it first (section 5.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ubuntu's disk is read-only after a power loss                                                                                                        | WSL mounted the damaged disk read-only                                                                                                                                                                                                                                               | Follow Microsoft's repair steps (`wsl --mount ... --vhd --bare`, `e2fsck`) in [WSL disk space](https://learn.microsoft.com/en-us/windows/wsl/disk-space); they may need a second distribution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows disk is filling up                                                                                                                           | The WSL virtual disk grew (images, build cache)                                                                                                                                                                                                                                      | Section 10.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 12. What you must check yourself

These are the points the documentation does not settle. Each has a check in this guide.

1. **Nested virtualization on your VPS** (section 2.3). Ask the provider; Microsoft does not
   support WSL 2 on non-Microsoft hypervisors (KVM, Xen, VMware), even where it works.
2. **Which WSL a fresh server gets.** Microsoft does not document what the built-in `wsl.exe` of
   Server 2022/2025 installs. `wsl --version` must show 2.5.4 or later (section 3.1). WSL does
   not install updates on its own here: plan the monthly `wsl --update` and reboot (section 9.4).
3. **systemd on Server 2025.** The `[boot]` section is documented only for Windows 11 and
   Server 2022: `ps -p 1 -o comm=` must print `systemd` (section 4.3).
4. **Idle settings on Windows Server.** `vmIdleTimeout` is documented as Windows 11 only: the
   one-minute test in section 4.3 must leave Ubuntu running.
5. **Start at boot without a login.** Only community reports and WSL's source support the
   scheduled-task method, and there are failure reports on Server 2025. The reboot tests in
   sections 5.2 and 8.7 are not optional. Whether a stored-password task is needed (versus
   "Do not store password") and whether a start delay helps are untested. That a WSL update
   restarts the WSL service is an inference from WSL's source; rebooting after it (section 9.4)
   covers both cases.
6. **Remote Desktop sign-out vs. disconnect.** WSL's source says a session started by the boot
   task survives your sign-out; closing the Remote Desktop window without signing out should be
   harmless too, but neither is documented. Section 5.2 step 3 tests the sign-out.
7. **The task's time limit** prints `PT0S` (section 5.1 step 3).
8. **`http://localhost:8000` from Windows** (section 7.5). Only needed for local testing.
9. **Docker networking in WSL.** Docker's default firewall backend should work with the current
   WSL kernel (it has the needed modules), but Docker does not document Engine inside WSL:
   `hello-world`, the model download (outbound) and the health check (published port) together
   prove it. If containers cannot reach the internet, a clash between WSL's NAT addresses and
   Docker's 172.x networks is possible (check `ip route` in Ubuntu); it was not researched.
10. **Long jobs through the tunnel.** Cloudflare's pages disagree on whether streams longer than
    125 s are affected: run one job with separation on a song over 5 minutes and watch the
    progress page finish (section 8.6). Also try one large upload (40 to 50 MB) through the
    tunnel: how the 30-second Proxy Write Timeout applies to a slow upload is not documented.
11. **QUIC through WSL and Docker.** Whether UDP 7844 stays stable through WSL's NAT is not
    documented. If the tunnel flaps, switch to HTTP/2 (section 11).
12. **Cloudflare Access with the app.** What the installed web app and its progress stream do
    when an Access login expires was not researched: if you use Access, test a session after its
    expiry. The Zero Trust first-run screen (team name, plan) was not researched either
    (section 8.4). Also check the auto-created DNS record is Proxied (section 8.5).
13. **What a Windows reboot does to a running job.** Whether WSL shuts Ubuntu down cleanly on a
    Windows restart is not documented; the worker marks any job it lost as interrupted, so the
    only effect should be one retry. Check that `docker compose ps` shows all containers up
    after each reboot.
14. **WSL on a second disk** (`--location`, section 3.2) is untested; Microsoft's
    troubleshooting page still says WSL runs only on the system drive.
15. **Memory used by the image build.** The build has no memory limit and its peak was not
    measured. Update when no analysis is running; if a build stops with `exit code: 137`, stop
    the worker while building (section 10.1).
16. **`\\wsl$` in Explorer when the task started WSL.** WSL's source expects it to work; if it
    does not, copy backups through `/mnt/c` (section 10.3).
17. **Restoring the full backup** (section 10.5) was not tested; the commands follow Microsoft's
    documentation.

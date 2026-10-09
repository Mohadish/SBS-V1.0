# -*- coding: utf-8 -*-
"""DEMO.pdf (020389D-06 Rev A- — SW Programming Requirements for ACS LAD LRU) broken into animation steps.
Hand-curated from the text layer + visual reads of the words Print-To-PDF turned into outlines.
figs: 'F<n>' = Figure n of the document, 'T1'/'T2' = the two file tables (vector, rendered), 'F3' = the flow diagram (vector)."""

CH = {}
ROWS = []
def ch(code, name):
    CH[code] = name
def row(chcode, name, voice, notes='', figs=(), title='', page=None, docstep=''):
    ROWS.append(dict(ch=chcode, name=name, voice=voice, notes=notes, figs=list(figs), title=title, page=page, docstep=docstep))

# ───────────────────────────── 1. Scope ─────────────────────────────
ch('C01', 'Scope and files')
row('C01', 'Scope', 'This programming requirement describes the files, means and procedures required to program the ACS LAD, part number MB1910A-XX, with the software files listed in the Programming files section.',
    'Document 020389D-06, Rev A-, CAGE 2288A. Applies to ACS LAD P/N MB1910A-XX.', (), 'SW Programming Requirements for ACS LAD LRU', 7, '1')
row('C01', 'Attached files', 'Two archives are attached to this document. Prog_files.zip includes the software images and the script to be flashed to the system. Tools.zip includes the bin_to_exe program and the Total Comm configuration file used to run commands on the shell.',
    'Prog_files.zip — CRC32 0x93227963. Tools.zip — CRC32 0xB515234C. Recommended extraction folder: C:\\Users\\Gen_krm_lad\\Desktop\\VDD_E540', ('F1', 'F2'), 'Programming files and tools', 7, '1 a-b')

# ───────────────────────────── 1.2 Production flow ─────────────────────────────
ch('C02', 'Production programming process')
row('C02', 'Production flow', 'The production flow has two LRU programming steps. Production load programming happens before LRU-level testing begins, step one in the diagram. Customer load programming takes place after the final ATP and before the customer ATP, step three, so the LRU is delivered with the customer software.',
    'Step 1: Production build programming (AB1910X-YY). Step 2: ATP, ESS, VIB, ATP. Step 3: Customer SW programming (PB1910X-YY). Step 4: Customer tests, Customer ATP.', ('F3',), 'Production flow', 9, '1.2')

# ───────────────────────────── 2. Programming files ─────────────────────────────
ch('C03', 'Programming files')
row('C03', 'Production load files', 'To complete the full production load cycle, follow the sequences in Table 1, Production Files, using the programming tool specified for each sequence.',
    'Seq 1 Generic Loader (MPEG): GL_app_files-01-22.hex, GL checksum 0x22F8, VDD 6673A01-22. Seq 2 Generic Loader (MPEG): GL_mpeg_bsp-01-11.hex, 0x800A, VDD 6672A01-11. Seq 3 Generic Loader (MPEG): GL_u-boot-01-07.hex, 0x2E56, VDD 6670A01-07. Seq 4 Generic Loader (Full Image): Full_image.hex, 0x2C70, VDD 6669A05-40. Seq 5 Total Comm (TS EEPROM Bit Fix): TS EEPROM BIT FIX - Model 41.txt. Note: all programming file configurations are managed in PLM.',
    ('T1',), 'Table 1: Production files', 10, '2.1')
row('C03', 'Production load sequence', 'The production load sequence has three parts. First, program the MPEG, sequences one to three, using Generic Loader, as described in section 4. Second, program the Full Image, sequence four, using Generic Loader, as described in section 5. Third, program the EEPROM, sequence five, using Total Comm, as described in section 7, TS EEPROM Bit-Fix programming using SPI.',
    '', (), 'Production load programming sequence', 10, '2.2')
row('C03', 'Customer load files', 'To complete the customer software load cycle, follow the sequences in Table 2, Customer SW Files, using the programming tool specified for each sequence.',
    'Seq 1-3 MPEG files as in Table 1. Seq 4 Generic Loader (Bootstrap): Bootstrap_02_08.hex, 0x97BF, VDD 7837A00-41. Seq 5 BSP Operational: ACS_LAD_BSP_Operational_V01-13.hex, 0x5625, VDD 6665A01-13. Seq 6 BSP Loader: ACS_LAD_BSP_Loader_V01-13.hex, 0x7693. Seq 7 BSP Bootrom: ACS_LAD_BSP_Bootrom_V01-13.hex, 0xD31A. Seq 8 BSP Config file: configFile_CRC.hex, 0xF4D2. Seq 9 Eagle Config file: CF_delivery.bin — must be converted to hex first (Appendix C); hex checksum 0x4343, VDD 6275A01-10. Seq 10 Total Commander (Customer Load): OFP_07-00_Delivery.zip, CRC32 0x734F4619, VDD 6669A07-00.',
    ('T2',), 'Table 2: Customer SW files', 11, '2.3')
row('C03', 'Customer load sequence', 'If the production load sequence was already performed, continue directly to step five, programming the customer load software. Otherwise follow all five steps: program the MPEG, sequences one to three, with Generic Loader. Program the Bootstrap and BSP files, sequences four to eight, with Generic Loader. Convert the Eagle Config binary file to a hex file, sequence nine, with the Objcopyppc tool, as described in Appendix C. Program the Eagle Config hex file with Generic Loader. Finally, program the customer load software, sequence ten, with the Total Commander application, as described in section 6.',
    '', (), 'Customer load programming sequence', 11, '2.4')

# ───────────────────────────── 3. Equipment ─────────────────────────────
ch('C04', 'Equipment and set-up')
row('C04', 'Equipment and set-up', 'The hardware equipment is the LAD ACS test equipment, part number TB1709A-XX. The software set-up consists of Total Comm, Generic Loader and the LAD Control Panel. For installation instructions refer to the referenced documents.',
    'TE LAD ACS P/N TB1709A-XX. Total Comm: SVD TOTALCOMM 9935A04-00. Generic Loader: VDD 741B04-09. LAD Control Panel: VDD 0126A00-00.', (), 'Programming equipment and set-up', 12, '3')

# ───────────────────────────── 4.1 MPEG programming procedure ─────────────────────────────
ch('C05', 'MPEG programming procedure')
row('C05', 'Verify ATP not running', 'Verify that the TE ATP VDD is not running.', '', (), '', 13, '4.1-1')
row('C05', 'Open Total Comm', 'Open the Total Comm application.', '', ('F4',), 'Total Comm icon', 13, '4.1-2')
row('C05', 'Configure Total Comm', 'Configure Total Comm as shown in the picture and click Open Port.', '', ('F5',), 'Total Comm configuration', 13, '4.1-3')
row('C05', 'Open LAD Control Panel', 'Open the LAD Control Panel application, located on the desktop.', '', ('F6',), 'LAD_CPanel icon', 13, '4.1-4')
row('C05', 'Verify PDU main power', 'Verify that the green button on the TE PDU Main Power is ON, and press OK.', '', ('F7',), 'PDU green button', 13, '4.1-5')
row('C05', 'Wait for power-up', 'Wait for the unit to power up. The countdown needs to finish and the Go indicator will turn green.', '', ('F8',), 'LAD_CPanel', 14, '4.1-6')
row('C05', 'Open Discretes tab', 'Press the Discretes tab.', '', ('F9',), 'LAD_CPanel Discretes', 14, '4.1-7')
row('C05', 'Set MPEG discretes', 'Set the discrete switches for the MPEG programming configuration as shown.', '', ('F9',), 'LAD_CPanel Discretes', 14, '4.1-8')
row('C05', 'Verify PDU buttons ON', 'Verify that the 115 VAC, Main and Essential buttons at the UUT Control are powered ON.', '', ('F10',), 'PDU main power', 15, '4.1-9')
row('C05', 'Switch to Power tab', 'In LAD_CPanel, switch to the Power tab.', '', ('F11',), 'LAD_CPanel Power', 15, '4.1-10')
row('C05', 'Turn on Main and Essential', 'Turn on Main Power and Essential Power.', '', ('F11',), 'LAD_CPanel Power', 15, '4.1-11')
row('C05', 'Verify Loader mode', 'In the MPEG serial shell, verify that the MPEG mode is in Loader Mode, by seeing the TGL for MPEG and TGL Loader commands as shown. In addition, verify that the IP is 10.15.10.2.', 'IP = 10.15.10.2', ('F12',), 'Total Comm Loader mode', 16, '4.1-12')
row('C05', 'Choose connection type', 'If programming over fiber optic, follow steps 14 to 18. If programming over a copper cable without fiber optic, follow steps 19 to 22.', 'Fiber optic → steps 14-18. Copper cable → steps 19-22.', (), '', 16, '4.1-13')
row('C05', 'Fiber: open adapter settings', 'For programming over fiber optic, open the Control Panel, then Network and Sharing Center on the TE PC, and choose Change Adapter Settings.', '', (), '', 16, '4.1-14')
row('C05', 'Fiber: MPEG fiber properties', 'Right-click the MPEG fiber connection and select Properties.', '', ('F13',), 'Network connection', 16, '4.1-15')
row('C05', 'Fiber: open TCP/IPv4', 'Open Internet Protocol Version 4, TCP/IPv4.', '', ('F14',), 'Network connection TCP/IPv4', 17, '4.1-16')
row('C05', 'Fiber: set IP address', 'Configure the IP address to 10.15.10.33 and the subnet mask to 255.255.255.0.', 'IP 10.15.10.33, mask 255.255.255.0', ('F15',), 'Network connection IP change', 17, '4.1-17')
row('C05', 'Fiber: continue', 'Proceed to step 23.', 'Source document shows a broken cross-reference ("Error! Reference source not found."); the intended target is step 23 (open Command Prompt).', (), '', 17, '4.1-18')
row('C05', 'Copper: disable mpeg_fiber', 'For programming over a copper cable without fiber optic, connect cable assembly W1 ESL, part number 073782A-00, from the TE to the UUT. Open the Control Panel, then Network and Internet, then Network and Sharing Center on the TE PC, choose Change Adapter Settings, right-click the mpeg_fiber connection and select Disable.', 'Cable assy W1 ESL P/N 073782A-00', ('F16',), 'Mpeg_Fiber disabling', 18, '4.1-19')
row('C05', 'Copper: mpeg properties', 'Right-click the mpeg connection and select Properties.', '', ('F17',), 'Mpeg properties', 18, '4.1-20')
row('C05', 'Copper: open TCP/IPv4', 'Open Internet Protocol Version 4, TCP/IPv4.', '', ('F18',), 'Mpeg network connection TCP/IPv4', 18, '4.1-21')
row('C05', 'Copper: set IP address', 'Configure the IP address to 10.15.10.3 and the subnet mask to 255.255.255.0, then press OK.', 'IP 10.15.10.3, mask 255.255.255.0', ('F19',), 'Network connection IP change', 19, '4.1-22')
row('C05', 'Open Command Prompt', 'Open the Command Prompt: press Win+R, type cmd, and press Enter.', '', (), '', 19, '4.1-23')
row('C05', 'Ping the MPEG', 'Type ping 10.15.10.2 and press Enter. If needed, wait up to five minutes for the Ethernet to stabilize.', 'ping 10.15.10.2 — allow up to 5 minutes for Ethernet stabilization.', ('F20',), 'CMD ping', 19, '4.1-24')
row('C05', 'Verify ping response', 'Verify the ping response from the MPEG IP address, as shown.', '', ('F20',), 'CMD ping', 19, '4.1-25')
row('C05', 'Open Generic Loader', 'Open the Generic Loader application.', '', ('F21',), 'Generic Loader icon', 19, '4.1-26')
row('C05', 'Enter password', 'If prompted for a password, enter 17234 and click Enter.', 'Password: 17234', (), '', 19, '4.1-27')
row('C05', 'Verify GL tabs', 'Verify that the Generic Loader Details and Protocol tabs are similar to the images shown.', '', ('F22',), 'Generic Loader configuration', 20, '4.1-28')
row('C05', 'Verify GL IP and port', 'Verify that the IP is 10.15.10.2 and the port is 2930.', 'IP 10.15.10.2, port 2930', ('F22',), 'Generic Loader configuration', 20, '4.1-29')
row('C05', 'Click GetFile', 'Click GetFile in the Loader tab.', '', ('F23',), 'Generic Loader', 20, '4.1-30')
row('C05', 'Load MPEG file', 'Load the MPEG file to the target from the location of the files, according to Table 1, Production Files, sequence one.', 'Sequence 1: GL_app_files-01-22.hex', ('F23',), 'Generic Loader', 20, '4.1-31')
row('C05', 'Verify checksum', 'Verify the Generic Loader checksum.', 'Expected checksum per Table 1 (seq 1: 0x22F8, seq 2: 0x800A, seq 3: 0x2E56).', ('F23',), 'Generic Loader', 20, '4.1-32')
row('C05', 'Press Start', 'Press Start and wait until the file is loaded and verified. Repeat if needed.', '', ('F23',), 'Generic Loader', 20, '4.1-33')
row('C05', 'Check 100%', 'Check that Load and Verify both show 100 percent.', '', (), '', 20, '4.1-34')
row('C05', 'Repeat for sequences 2 and 3', 'Repeat steps 31 to 34 for sequences two and three from Table 1, Production Files.', 'Seq 2: GL_mpeg_bsp-01-11.hex (0x800A). Seq 3: GL_u-boot-01-07.hex (0x2E56).', (), '', 20, '4.1-35')

# ───────────────────────────── 4.2 MPEG files verification ─────────────────────────────
ch('C06', 'MPEG files verification')
row('C06', 'Reboot target', 'Reboot the target by turning the Main and Essential power OFF and then ON.', '', ('F24',), 'LAD_CPanel', 21, '4.2-36')
row('C06', 'Open MPEG serial shell', 'Open the MPEG serial shell using the Total Comm application, configured as in Figure 5.', '', ('F5',), 'Total Comm configuration', 21, '4.2-37')
row('C06', 'Verify MPEG versions', 'Verify that all the MPEG file versions, APP, UBOOT and BSP, listed in Table 1 were burned, by typing the /usr/lhv command in the MPEG serial shell, or by clicking the Version button.', 'Command: /usr/lhv', ('F25',), 'MPEG versions command in shell', 21, '4.2-38')
row('C06', 'Return switches to Operation', 'At the end of the programming process, all switches should be returned to the Operation mode configuration, as they were before.', '', ('F26',), 'LAD_CPanel Discretes off', 22, '4.2-39')
row('C06', 'Turn OFF power', 'Turn OFF Main Power and Essential Power.', '', ('F27',), 'LAD_CPanel Power off', 22, '4.2-40')

# ───────────────────────────── 5. Software programming with Generic Loader ─────────────────────────────
ch('C07', 'Software programming with Generic Loader')
row('C07', 'Extract Prog_files.zip', 'The following instructions are the same for both sides; the left side is shown as an example, and both sides can be programmed simultaneously. Extract Prog_files.zip, attached to this document, if needed.', 'Both sides can be programmed simultaneously.', (), '', 23, '5-1')
row('C07', 'Open LAD Control Panel', 'Open the LAD Control Panel application, located on the desktop, if needed.', '', ('F28',), 'LAD_CPanel icon', 23, '5-2')
row('C07', 'Verify PDU main power', 'Verify that the green button on the TE PDU Main Power is on, and press OK, if needed.', '', ('F29',), 'PDU green button', 23, '5-3')
row('C07', 'Wait for power-up', 'Wait for the unit to power up. The countdown needs to finish and the Go indicator will turn green.', '', ('F30',), 'LAD_CPanel', 23, '5-4')
row('C07', 'Open Discretes tab', 'Press the Discretes tab.', '', ('F31',), 'LAD_CPanel WD', 24, '5-5')
row('C07', 'Verify write protection off', 'Verify that the flash write protection is disabled.', '', ('F31',), 'LAD_CPanel WD', 24, '5-6')
row('C07', 'Verify PDU buttons ON', 'Verify that the 115 VAC, Main and Essential buttons at the UUT Control are powered ON.', '', ('F32',), 'PDU main power', 24, '5-7')
row('C07', 'Turn ON power', 'Turn ON Main Power and Essential Power in the Power tab.', '', ('F33',), 'LAD_CPanel Power', 25, '5-8')
row('C07', 'Configure Total Comm', 'Configure Total Comm according to Appendix A, Total Comm configuration, for the left and right sides.', 'See Appendix A.', (), '', 25, '5-9')
row('C07', 'Format TFFS', 'In the target shell, execute the following command to format the TFFS section in flash. Wait until it finishes, about ten minutes.', 'Takes about 10 minutes. The shell prints the format progress (second picture).', ('F34', 'F35'), 'Total Comm TFFS format', 25, '5-10')
row('C07', 'Enable Typhoon SW loading', 'Press the EN TYPHOON SW LOADING button several times, until value equals minus one is printed in the shell, for both sides, left and right.', 'Repeat until the shell prints "value= -1". Both sides.', ('F36',), 'Typhoon enabling', 26, '5-11')
row('C07', 'Open two Generic Loaders', 'Open two instances of the Generic Loader application, one for the left side and one for the right side.', '', ('F37',), 'Generic Loader icon', 26, '5-12')
row('C07', 'Enter password', 'If prompted for a password, enter 17234 and click Enter.', 'Password: 17234', (), '', 26, '5-13')
row('C07', 'Generic Loader screen', 'Typically, a screen similar to the one shown will appear.', '', ('F38',), 'Generic Loader', 26, '5-14')
row('C07', 'Check Details tab', 'Open the Details tab of the Generic Loader and check that all the parameters are as shown.', '', ('F39',), 'Generic Loader Details', 27, '5-15')
row('C07', 'Set Typhoon IP', 'Open the Protocol tab of the Generic Loader and set the IP of the Typhoon in the IP Address window. Make sure the Typhoon IP is compatible with the PC: for Typhoon Left set 172.25.0.121, for Typhoon Right set 172.25.0.122.', 'Typhoon Left: 172.25.0.121. Typhoon Right: 172.25.0.122.', ('F40',), 'Generic Loader Protocol', 27, '5-16')
row('C07', 'Select full_image.hex', 'In the Loader tab, select the full_image.hex file to load, from the location of the file according to Table 1, Production Files, sequence four.', 'Sequence 4: Full_image.hex, GL checksum 0x2C70.', ('F41',), 'Generic Loader checksum', 28, '5-17')
row('C07', 'Verify checksum', 'Verify that the loaded file checksum matches the one in Table 1, Production Files. In case of an error message, repeat the process.', 'Expected: 0x2C70', ('F41',), 'Generic Loader checksum', 28, '5-18')
row('C07', 'Press Start', 'Press Start and wait until the file is loaded and verified. Repeat if needed.', '', (), '', 28, '5-19')
row('C07', 'Programming completed', 'After the programming is completed successfully, the message Loading and Verifying Completed Successfully will appear.', 'Expected message: "Loading and Verifying Completed Successfully!"', (), '', 28, '5-20')

# ───────────────────────────── 6. Software programming with Total Commander ─────────────────────────────
ch('C08', 'Software programming with Total Commander')
row('C08', 'Customer load via FTP', 'This section describes the installation of the customer load, the OFP, by copying files to the TFFS flash memory file system. The instructions are the same for both sides and can be performed simultaneously; the left side is shown as an example. Before starting an FTP connection, make sure the target IP addresses are configured in the FTP connection menu.', 'If the IP addresses are not configured in the FTP connection menu, refer to Appendix B.', (), 'Software programming with Total Commander', 29, '6')
row('C08', 'Open Total Commander', 'Open Total Commander.', '', (), '', 29, '6-1')
row('C08', 'Click the FTP button', 'Click the FTP button.', '', ('F42',), 'FTP server connection', 29, '6-2')
row('C08', 'Verify left and right', 'Verify that the left and right options are shown. If the IP addresses are not configured, refer to Appendix B, Total Commander FTP configuration.', '', ('F42',), 'FTP server connection', 29, '6-3')
row('C08', 'Verify unit powered', 'Verify that the unit is powered on. If it is not powered already, refer to section 4.1, steps 4 to 11.', 'See 4.1 steps 4-11 (Customer Load Updating Procedure).', (), '', 29, '6-4')
row('C08', 'Configure TY ETH', 'Before programming over the Ethernet connection, perform the Typhoon left and right Ethernet configuration, as described in Appendix A, Total Comm configuration.', 'See Appendix A.', (), '', 29, '6-5')
row('C08', 'Start FTP session', 'Start an FTP session using Total Commander with the IP address 172.25.0.121, Typhoon Left.', 'Left: 172.25.0.121 (Right: 172.25.0.122).', (), '', 29, '6-6')
row('C08', 'Open delivery folder', 'In the right side of the Total Commander window, navigate to the delivery folder OFP_07-00_Delivery, extracted from OFP_07-00_Delivery.zip, part of the Prog_files archive.', 'C:\\Users\\Gen_krm_lad\\Desktop\\VDD_E540\\Prog_files\\Customer Load\\OFP_07-00_Delivery', ('F43',), 'FTP delivery folder', 30, '6-7')
row('C08', 'Open LAD root folder', 'In the left side of Total Commander, navigate to the LAD root folder, tffs.', 'Target root folder: /tffs0', ('F44',), 'FTP LAD root folder', 30, '6-8')
row('C08', 'Copy the OFP files', 'Copy the files inside the OFP folder: click the OFP folder, press Control A, then drag all the folder content to the target root folder, tffs0. After that, click Overwrite all.', 'Note: during the copying process you might need to click the Retry button in Total Commander.', ('F45',), 'OFP overwrite', 31, '6-9')
row('C08', 'Power cycle', 'Perform a power cycle by turning the unit off and on.', '', ('F46',), 'LAD_CPanel Power off', 32, '6-10')
row('C08', 'Check UUT versions', 'Check that the UUT versions are installed properly, by pressing the OSS buttons 8 and 10, left or right side, and receiving the following image.', 'OSS buttons 8, 10.', ('F47',), 'LAD versions', 32, '6-11')

# ───────────────────────────── 7. TS EEPROM Bit-Fix programming using SPI ─────────────────────────────
ch('C09', 'TS EEPROM Bit-Fix programming using SPI')
row('C09', 'Open Total Comm', 'Manual TS EEPROM programming using SPI at LRU level. Open the Total Comm application.', '', ('F48',), 'Total Comm icon', 33, '7-1')
row('C09', 'Configure Total Comm', 'Configure Total Comm as shown in the picture and click Open Port.', '', ('F49',), 'Total Comm configuration', 33, '7-2')
row('C09', 'Run the Bit-Fix script', 'Click the Browse button in Total Comm and run the script TS EEPROM BIT FIX - Model 41.txt, from the location of the file according to Table 1, Production Files, sequence five.', 'Script: "TS EEPROM BIT FIX - Model 41.txt" (Table 1, seq 5).', ('F50',), 'TS EEPROM BIT FIX script', 33, '7-3')
row('C09', 'Burning in progress', 'The burning procedure starts immediately. The output in the shell should be similar to the following.', '', ('F51',), 'TS EEPROM programming using SPI', 34, '7-4')
row('C09', 'Power cycle', 'Perform a power cycle by turning the unit off and on.', 'Numbered "12" in the source document (numbering glitch).', ('F52',), 'LAD_CPanel Power off', 34, '7-12')

# ───────────────────────────── Appendix A ─────────────────────────────
ch('C10', 'Appendix A — Total Comm configuration')
row('C10', 'Ensure Total Comm installed', 'Ensure that the Total Comm tool is installed. For details, refer to the SVD TOTALCOMM document.', 'SVD TOTALCOMM 9935A04-00.', (), '', 35, 'A-1')
row('C10', 'Open Total Comm', 'Open Total Comm.', '', (), '', 35, 'A-2')
row('C10', 'Total Comm window', 'The following window will appear.', '', ('F53',), 'Total Comm', 35, 'A-3')
row('C10', 'Select the COM port', 'Configure the Total Comm shell for the left side on COM19; use COM21 for the right side.', 'Left: COM19. Right: COM21.', (), '', 35, 'A-4')
row('C10', 'Set port and baud rate', 'Update the port settings to the connected port and set the baud rate to 115200.', 'Baud rate 115200.', ('F54',), 'Total Comm port and baud rate', 35, 'A-5')
row('C10', 'Open Port', 'Click the Open Port button. The following window will appear.', '', ('F55',), 'Total Comm Open Port', 36, 'A-6')
row('C10', 'Locate configuration file', 'Locate the TotalComm_Configuration.txt file attached to this document, from the location of the file according to the Scope section, Tools.zip.', 'File: TotalComm_Configuration.txt (inside Tools.zip).', (), '', 36, 'A-7')
row('C10', 'Load configuration', 'Press the Load button and select the TotalComm_Configuration.txt file to load.', '', ('F56',), 'TotalComm load configuration', 36, 'A-8')
row('C10', 'Right side IP config', 'Click TY_R IP config for the right side LAD configuration, on the right side Total Comm instance.', '', ('F57',), 'Total Comm Typhoon IP config', 37, 'A-9')
row('C10', 'Left side IP config', 'Click TY_L IP config for the left side LAD configuration, on the left side Total Comm instance.', '', ('F57',), 'Total Comm Typhoon IP config', 37, 'A-10')

# ───────────────────────────── Appendix B ─────────────────────────────
ch('C11', 'Appendix B — Total Commander FTP configuration')
row('C11', 'FTP connection parameters', 'This appendix details the steps to configure an FTP connection, allowing the update of the OFP application files on the TFFS flash memory file system. In the Total Commander FTP connection menu, configure the host name as the target IP address, 172.25.0.121 for the left side Typhoon and 172.25.0.122 for the right side, and the user name and password configured in the target, usually acs.',
    'Host: 172.25.0.121 (Left) / 172.25.0.122 (Right). User name: acs. Password: acs. Note: target IP, username and password can be viewed by typing "version" in the target shell.', (), 'Total Commander FTP configuration', 38, 'B')
row('C11', 'Net > FTP Connect', 'Creating a new FTP connection: from the pull-down menu select Net, and then press FTP Connect.', '', ('F58',), 'FTP connection', 38, 'B-A')
row('C11', 'New Connection', 'Click the New Connection button to add a new connection.', '', ('F59',), 'FTP new connection', 39, 'B-B')
row('C11', 'Fill connection details', 'Fill in the connection details: Session, any name, usually including the IP and the selected side name. Host name, the selected side Typhoon IP address. User name acs, password acs. Leave all other fields unchanged.', 'Session: any name. Host name: side Typhoon IP. User: acs. Password: acs.', ('F60',), 'FTP connection details', 39, 'B-C')
row('C11', 'Repeat for both sides', 'Repeat the steps for both sides, left and right.', '', (), '', 39, 'B-D')

# ───────────────────────────── Appendix C ─────────────────────────────
ch('C12', 'Appendix C — EOGL hex file generation')
row('C12', 'Extract EOGL_CF.bin', 'Extract EOGL_CF.bin from the EOGL_CF VDD and place the file in a folder on your local PC.', '', (), '', 40, 'C-1')
row('C12', 'Add Tools.zip', 'Place the Tools.zip file, attached to this release, in the same folder.', '', (), '', 40, 'C-2')
row('C12', 'Extract objcopyppc.exe', 'Extract the file objcopyppc.exe from Tools.zip to the same folder.', '', (), '', 40, 'C-3')
row('C12', 'Open the command line', 'Open the command line and change the directory to the same folder.', '', (), '', 40, 'C-4')
row('C12', 'Run objcopyppc', 'Run the following command: objcopyppc, dash capital I binary, dash capital O srec, dash dash adjust-vma 0xF8000000, EOGL_CF.bin, EOGL_CF.hex.', 'objcopyppc -I binary -O srec --adjust-vma 0xF8000000 EOGL_CF.bin EOGL_CF.hex', ('F61',), 'CMD EOGL hex file', 40, 'C-5')
row('C12', 'Program both sides', 'Use the generated hex file and program both sides, left and right, according to Appendix B, Total Commander FTP configuration.', '', (), '', 40, 'C-6')

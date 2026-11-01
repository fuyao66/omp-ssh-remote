// Official LLVM/Ubuntu archives authenticated against signed metadata during ELF audit.
export const CPP_LSP_PINS = {
  "version": "23.1.5",
  "packageVersion": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
  "resourceVersion": "23",
  "glibc": "2.29",
  "llvmSigningFingerprint": "6084F3CF814B57C1CF12EFD515CF4D18AF4F7421",
  "ubuntuSigningFingerprints": [
    "790BC7277767219C42C86F933B4FE6ACC0B21F32",
    "F6ECB3762474EDA9D21B7022871920D1991BC93C"
  ],
  "sources": {
    "arm64": [
      {
        "name": "clangd-23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/clangd-23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_arm64.deb",
        "sha256": "c3742361e07858fe5dbe515cce5f8600cfb26185e062b87d6a5ae0ab5488180c",
        "files": [
          {
            "source": "usr/lib/llvm-23/bin/clangd",
            "target": "bin/clangd.real"
          },
          {
            "source": "usr/share/doc/clangd-23/copyright",
            "target": "licenses/clangd-23-copyright"
          }
        ]
      },
      {
        "name": "libclang-common-23-dev",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libclang-common-23-dev_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_arm64.deb",
        "sha256": "44f66023e2d6be17d4c5de929821b787eb1042240778fb2ab90f9485d4844bf7",
        "files": [
          {
            "source": "usr/lib/llvm-23/lib/clang/23/include/",
            "target": "lib/clang/23/include/"
          },
          {
            "source": "usr/share/doc/libclang-common-23-dev/copyright",
            "target": "licenses/libclang-common-23-dev-copyright"
          }
        ]
      },
      {
        "name": "libclang-cpp23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libclang-cpp23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_arm64.deb",
        "sha256": "4140461862a37378058f5393b8fae32a2e96679b97a1214998c112b17d38b302",
        "files": [
          {
            "source": "usr/lib/aarch64-linux-gnu/libclang-cpp.so.23.1",
            "target": "lib/libclang-cpp.so.23.1"
          },
          {
            "source": "usr/share/doc/libclang-cpp23/copyright",
            "target": "licenses/libclang-cpp23-copyright"
          }
        ]
      },
      {
        "name": "libllvm23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libllvm23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_arm64.deb",
        "sha256": "e4720d1d53778b9f58075dfed3882df667f5edc7cd3f2a5f4076ad43223136ab",
        "files": [
          {
            "source": "usr/lib/aarch64-linux-gnu/libLLVM.so.23.1",
            "target": "lib/libLLVM.so.23.1"
          },
          {
            "source": "usr/share/doc/libllvm23/copyright",
            "target": "licenses/libllvm23-copyright"
          }
        ]
      },
      {
        "name": "libstdc++6",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-10/libstdc++6_10.5.0-1ubuntu1~20.04_arm64.deb",
        "sha256": "622193725b4cd8775dd7a42d7532e6e8f06ccb0095bd0fbf70776242cd8342f3",
        "files": [
          {
            "source": "usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.28",
            "target": "lib/libstdc++.so.6"
          }
        ]
      },
      {
        "name": "libgcc-s1",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-10/libgcc-s1_10.5.0-1ubuntu1~20.04_arm64.deb",
        "sha256": "9638c0a04a540175e34314f51bc3c5709859c6f7690cb16f2deccbf8f5f1ecc6",
        "files": [
          {
            "source": "lib/aarch64-linux-gnu/libgcc_s.so.1",
            "target": "lib/libgcc_s.so.1"
          }
        ]
      },
      {
        "name": "gcc-10-base",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://ports.ubuntu.com/ubuntu-ports/pool/main/g/gcc-10/gcc-10-base_10.5.0-1ubuntu1~20.04_arm64.deb",
        "sha256": "b099a2d475b16fe466a435fff8c1bac7385645b77fb632e21f782f0c6787e990",
        "files": [
          {
            "source": "usr/share/doc/gcc-10-base/copyright",
            "target": "licenses/gcc-10-base-copyright"
          }
        ]
      },
      {
        "name": "base-files",
        "version": "11ubuntu5",
        "url": "https://ports.ubuntu.com/ubuntu-ports/pool/main/b/base-files/base-files_11ubuntu5_arm64.deb",
        "sha256": "252b15b8240184a067146e8688598c55fd2f8d0b8f7243100bde063da25f4cf7",
        "files": [
          {
            "source": "usr/share/common-licenses/MPL-2.0",
            "target": "licenses/common/MPL-2.0"
          },
          {
            "source": "usr/share/common-licenses/MPL-1.1",
            "target": "licenses/common/MPL-1.1"
          },
          {
            "source": "usr/share/common-licenses/LGPL-3",
            "target": "licenses/common/LGPL-3"
          },
          {
            "source": "usr/share/common-licenses/LGPL-2.1",
            "target": "licenses/common/LGPL-2.1"
          },
          {
            "source": "usr/share/common-licenses/LGPL-2",
            "target": "licenses/common/LGPL-2"
          },
          {
            "source": "usr/share/common-licenses/GPL-3",
            "target": "licenses/common/GPL-3"
          },
          {
            "source": "usr/share/common-licenses/GPL-2",
            "target": "licenses/common/GPL-2"
          },
          {
            "source": "usr/share/common-licenses/GPL-1",
            "target": "licenses/common/GPL-1"
          },
          {
            "source": "usr/share/common-licenses/GFDL-1.3",
            "target": "licenses/common/GFDL-1.3"
          },
          {
            "source": "usr/share/common-licenses/GFDL-1.2",
            "target": "licenses/common/GFDL-1.2"
          },
          {
            "source": "usr/share/common-licenses/CC0-1.0",
            "target": "licenses/common/CC0-1.0"
          },
          {
            "source": "usr/share/common-licenses/BSD",
            "target": "licenses/common/BSD"
          },
          {
            "source": "usr/share/common-licenses/Artistic",
            "target": "licenses/common/Artistic"
          },
          {
            "source": "usr/share/common-licenses/Apache-2.0",
            "target": "licenses/common/Apache-2.0"
          }
        ]
      }
    ],
    "x64": [
      {
        "name": "clangd-23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/clangd-23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_amd64.deb",
        "sha256": "4c5891995b8e34a5144e77daa5caa3151ed17f3fa15ea70df12a0ad2aef8330e",
        "files": [
          {
            "source": "usr/lib/llvm-23/bin/clangd",
            "target": "bin/clangd.real"
          },
          {
            "source": "usr/share/doc/clangd-23/copyright",
            "target": "licenses/clangd-23-copyright"
          }
        ]
      },
      {
        "name": "libclang-common-23-dev",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libclang-common-23-dev_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_amd64.deb",
        "sha256": "fe9cb882384f4974462a5aa2053e2813f943627bfd7b5e5932808ea87bff9b9c",
        "files": [
          {
            "source": "usr/lib/llvm-23/lib/clang/23/include/",
            "target": "lib/clang/23/include/"
          },
          {
            "source": "usr/share/doc/libclang-common-23-dev/copyright",
            "target": "licenses/libclang-common-23-dev-copyright"
          }
        ]
      },
      {
        "name": "libclang-cpp23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libclang-cpp23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_amd64.deb",
        "sha256": "ac80a7b5db0e21b33e5df5e2592c8bea044686a04a64ee123ca82d051d42733d",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libclang-cpp.so.23.1",
            "target": "lib/libclang-cpp.so.23.1"
          },
          {
            "source": "usr/share/doc/libclang-cpp23/copyright",
            "target": "licenses/libclang-cpp23-copyright"
          }
        ]
      },
      {
        "name": "libllvm23",
        "version": "1:23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94",
        "url": "https://apt.llvm.org/focal/pool/main/l/llvm-toolchain-23/libllvm23_23.1.5~++20261028083830+a738f2737189-1~exp1~20261028203946.94_amd64.deb",
        "sha256": "f1fac0932eb846254d8febaa9fbf4e222af22cd32778df166cb8c97412135560",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libLLVM.so.23.1",
            "target": "lib/libLLVM.so.23.1"
          },
          {
            "source": "usr/share/doc/libllvm23/copyright",
            "target": "licenses/libllvm23-copyright"
          }
        ]
      },
      {
        "name": "libstdc++6",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-10/libstdc++6_10.5.0-1ubuntu1~20.04_amd64.deb",
        "sha256": "7f9222342d3551d063bf651319ec397c39278eeeb9ab5950ae0e8c28ef0af431",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.28",
            "target": "lib/libstdc++.so.6"
          }
        ]
      },
      {
        "name": "libgcc-s1",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-10/libgcc-s1_10.5.0-1ubuntu1~20.04_amd64.deb",
        "sha256": "4aa7b9c9f3225df65a750ae0ff5c890fc6108c82a609b3c5abd45d211838bf3c",
        "files": [
          {
            "source": "lib/x86_64-linux-gnu/libgcc_s.so.1",
            "target": "lib/libgcc_s.so.1"
          }
        ]
      },
      {
        "name": "libffi7",
        "version": "3.3-4",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/libf/libffi/libffi7_3.3-4_amd64.deb",
        "sha256": "4584aa8fef1bf5086168ce2f7078cd2ebd78fdc4cc0d86d958d795d4e0b0f50d",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libffi.so.7.1.0",
            "target": "lib/libffi.so.7"
          },
          {
            "source": "usr/share/doc/libffi7/copyright",
            "target": "licenses/libffi7-copyright"
          }
        ]
      },
      {
        "name": "libedit2",
        "version": "3.1-20191231-1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/libe/libedit/libedit2_3.1-20191231-1_amd64.deb",
        "sha256": "51a1190157e2dfe2c26bbdc114d1fc659456def2e78e6e9582809cf92a0a49a4",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libedit.so.2.0.63",
            "target": "lib/libedit.so.2"
          },
          {
            "source": "usr/share/doc/libedit2/copyright",
            "target": "licenses/libedit2-copyright"
          }
        ]
      },
      {
        "name": "libxml2",
        "version": "2.9.10+dfsg-5ubuntu0.20.04.10",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.10+dfsg-5ubuntu0.20.04.10_amd64.deb",
        "sha256": "90145086978f8eb6253621eea93dd1fb144ff6475a17507e467557d63d427e7f",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libxml2.so.2.9.10",
            "target": "lib/libxml2.so.2"
          },
          {
            "source": "usr/share/doc/libxml2/copyright",
            "target": "licenses/libxml2-copyright"
          }
        ]
      },
      {
        "name": "libzstd1",
        "version": "1.4.4+dfsg-3ubuntu0.1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd1_1.4.4+dfsg-3ubuntu0.1_amd64.deb",
        "sha256": "7a4422dadb90510dc90765c308d65e61a3e244ceb3886394335e48cff7559e69",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libzstd.so.1.4.4",
            "target": "lib/libzstd.so.1"
          },
          {
            "source": "usr/share/doc/libzstd1/copyright",
            "target": "licenses/libzstd1-copyright"
          }
        ]
      },
      {
        "name": "zlib1g",
        "version": "1:1.2.11.dfsg-2ubuntu1.5",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/z/zlib/zlib1g_1.2.11.dfsg-2ubuntu1.5_amd64.deb",
        "sha256": "bf67018f5303466eb468680b637a5d3f3bb17b9d44decf3d82d40b35babcd3e0",
        "files": [
          {
            "source": "lib/x86_64-linux-gnu/libz.so.1.2.11",
            "target": "lib/libz.so.1"
          },
          {
            "source": "usr/share/doc/zlib1g/copyright",
            "target": "licenses/zlib1g-copyright"
          }
        ]
      },
      {
        "name": "libbsd0",
        "version": "0.10.0-1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/libb/libbsd/libbsd0_0.10.0-1_amd64.deb",
        "sha256": "4f668025fe923a372eb7fc368d6769fcfff6809233d48fd20fc072917cd82e60",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libbsd.so.0.10.0",
            "target": "lib/libbsd.so.0"
          },
          {
            "source": "usr/share/doc/libbsd0/copyright",
            "target": "licenses/libbsd0-copyright"
          }
        ]
      },
      {
        "name": "libtinfo6",
        "version": "6.2-0ubuntu2.1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/n/ncurses/libtinfo6_6.2-0ubuntu2.1_amd64.deb",
        "sha256": "711a3a901c3a71561565558865699efa9c07a99fdc810ffe086a5636f89c6431",
        "files": [
          {
            "source": "lib/x86_64-linux-gnu/libtinfo.so.6.2",
            "target": "lib/libtinfo.so.6"
          },
          {
            "source": "usr/share/doc/libtinfo6/copyright",
            "target": "licenses/libtinfo6-copyright"
          }
        ]
      },
      {
        "name": "libicu66",
        "version": "66.1-2ubuntu2.1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu66_66.1-2ubuntu2.1_amd64.deb",
        "sha256": "00d0de456134668f41bd9ea308a076bc0a6a805180445af8a37209d433f41efe",
        "files": [
          {
            "source": "usr/lib/x86_64-linux-gnu/libicudata.so.66.1",
            "target": "lib/libicudata.so.66"
          },
          {
            "source": "usr/lib/x86_64-linux-gnu/libicuuc.so.66.1",
            "target": "lib/libicuuc.so.66"
          },
          {
            "source": "usr/share/doc/libicu66/copyright",
            "target": "licenses/libicu66-copyright"
          }
        ]
      },
      {
        "name": "liblzma5",
        "version": "5.2.4-1ubuntu1.1",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/x/xz-utils/liblzma5_5.2.4-1ubuntu1.1_amd64.deb",
        "sha256": "f545d34c86119802fbae869a09e1077a714e12a01ef6a3ef67fdc745e5db311d",
        "files": [
          {
            "source": "lib/x86_64-linux-gnu/liblzma.so.5.2.4",
            "target": "lib/liblzma.so.5"
          },
          {
            "source": "usr/share/doc/liblzma5/copyright",
            "target": "licenses/liblzma5-copyright"
          }
        ]
      },
      {
        "name": "gcc-10-base",
        "version": "10.5.0-1ubuntu1~20.04",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-10/gcc-10-base_10.5.0-1ubuntu1~20.04_amd64.deb",
        "sha256": "8fac06791057b1bba6178466e160bb3ec2a795297f10e88e34daf762572ed5c0",
        "files": [
          {
            "source": "usr/share/doc/gcc-10-base/copyright",
            "target": "licenses/gcc-10-base-copyright"
          }
        ]
      },
      {
        "name": "base-files",
        "version": "11ubuntu5",
        "url": "https://archive.ubuntu.com/ubuntu/pool/main/b/base-files/base-files_11ubuntu5_amd64.deb",
        "sha256": "f3d42324001218db6d1d1489d59b83e2e73f5ae45823230145b9a559254e0034",
        "files": [
          {
            "source": "usr/share/common-licenses/MPL-2.0",
            "target": "licenses/common/MPL-2.0"
          },
          {
            "source": "usr/share/common-licenses/MPL-1.1",
            "target": "licenses/common/MPL-1.1"
          },
          {
            "source": "usr/share/common-licenses/LGPL-3",
            "target": "licenses/common/LGPL-3"
          },
          {
            "source": "usr/share/common-licenses/LGPL-2.1",
            "target": "licenses/common/LGPL-2.1"
          },
          {
            "source": "usr/share/common-licenses/LGPL-2",
            "target": "licenses/common/LGPL-2"
          },
          {
            "source": "usr/share/common-licenses/GPL-3",
            "target": "licenses/common/GPL-3"
          },
          {
            "source": "usr/share/common-licenses/GPL-2",
            "target": "licenses/common/GPL-2"
          },
          {
            "source": "usr/share/common-licenses/GPL-1",
            "target": "licenses/common/GPL-1"
          },
          {
            "source": "usr/share/common-licenses/GFDL-1.3",
            "target": "licenses/common/GFDL-1.3"
          },
          {
            "source": "usr/share/common-licenses/GFDL-1.2",
            "target": "licenses/common/GFDL-1.2"
          },
          {
            "source": "usr/share/common-licenses/CC0-1.0",
            "target": "licenses/common/CC0-1.0"
          },
          {
            "source": "usr/share/common-licenses/BSD",
            "target": "licenses/common/BSD"
          },
          {
            "source": "usr/share/common-licenses/Artistic",
            "target": "licenses/common/Artistic"
          },
          {
            "source": "usr/share/common-licenses/Apache-2.0",
            "target": "licenses/common/Apache-2.0"
          }
        ]
      }
    ]
  },
  "metadata": [
    {
      "url": "https://apt.llvm.org/focal/dists/llvm-toolchain-focal-23/Release",
      "sha256": "a9552b9848124ad6459f7e51dbb45db1cbce06e5fefac28482760468ce238c88"
    },
    {
      "url": "https://archive.ubuntu.com/ubuntu/dists/focal/InRelease",
      "sha256": "cc9be89a0984aeca9e3ca40ae0e6decff75aa32653a5925b04956a7c12487e99"
    },
    {
      "url": "https://archive.ubuntu.com/ubuntu/dists/focal-updates/InRelease",
      "sha256": "03f519e44dc963536be66257fd6c2d6c02cd67de776f1fd6c38be93668256edc"
    },
    {
      "url": "https://ports.ubuntu.com/ubuntu-ports/dists/focal/InRelease",
      "sha256": "cc9be89a0984aeca9e3ca40ae0e6decff75aa32653a5925b04956a7c12487e99"
    },
    {
      "url": "https://ports.ubuntu.com/ubuntu-ports/dists/focal-updates/InRelease",
      "sha256": "03f519e44dc963536be66257fd6c2d6c02cd67de776f1fd6c38be93668256edc"
    },
    {
      "url": "https://apt.llvm.org/focal/dists/llvm-toolchain-focal-23/main/binary-arm64/Packages",
      "sha256": "7018469b014af140201565e1c98f087e1b3c2a8df86dbcc3fe70022f32c64337"
    },
    {
      "url": "https://apt.llvm.org/focal/dists/llvm-toolchain-focal-23/main/binary-amd64/Packages",
      "sha256": "08feff5a9ab7c5d992bed4ed247a7fbc8fef72a41b9db60c7ffcbcc9fc37bab7"
    }
    ,{
      "url": "https://archive.ubuntu.com/ubuntu/dists/focal/main/binary-amd64/Packages.xz",
      "sha256": "7757921ff8feed9c3934a0c9936d441ba4a238bee3ea6c8c1df5cbcd43fc9861"
    },
    {
      "url": "https://archive.ubuntu.com/ubuntu/dists/focal-updates/main/binary-amd64/Packages.xz",
      "sha256": "25b9929bdf280bd3c55732d3b351499518de3aa5dd00cfc9fbee1e765bb59a12"
    },
    {
      "url": "https://ports.ubuntu.com/ubuntu-ports/dists/focal/main/binary-arm64/Packages.xz",
      "sha256": "e014b241021d8c0cf16cb94f44f4cafb7746507769baf36b77845d3ae22e2c1b"
    },
    {
      "url": "https://ports.ubuntu.com/ubuntu-ports/dists/focal-updates/main/binary-arm64/Packages.xz",
      "sha256": "29210f1acdfba6002e84bdcb15f233a05cfe6ec4ecb4db582566763d5c6700a1"
    },
    {
      "url": "https://apt.llvm.org/focal/dists/llvm-toolchain-focal-23/Release.gpg",
      "sha256": "cd6a44dc3c14d96930e5b261b3eb20d114c67066a770a65614669abbe7771e6c"
    }
  ]
} as const;
